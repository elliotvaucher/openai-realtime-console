import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";
import { io } from "socket.io-client";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const [socket, setSocket] = useState(null);
  const [username, setUsername] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [availableSessions, setAvailableSessions] = useState([]);
  const [messages, setMessages] = useState([]);
  const [connectedUsers, setConnectedUsers] = useState([]);
  const [showSessionModal, setShowSessionModal] = useState(true);
  const peerConnection = useRef(null);
  const audioElement = useRef(null);

  // Initialize socket connection
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on("user_joined", ({ username, users }) => {
      setConnectedUsers(users);
    });

    newSocket.on("user_left", ({ username, users }) => {
      setConnectedUsers(users);
    });

    newSocket.on("new_message", (messageData) => {
      setMessages(prev => [...prev, messageData]);
    });

    newSocket.on("session_history", (sessionMessages) => {
      setMessages(sessionMessages);
    });

    // Clean up on unmount
    return () => {
      newSocket.disconnect();
    };
  }, []);

  // Fetch available sessions
  useEffect(() => {
    if (!showSessionModal) return;
    
    fetch("/api/sessions")
      .then(res => res.json())
      .then(data => {
        setAvailableSessions(data);
      })
      .catch(err => {
        console.error("Failed to fetch sessions:", err);
      });
  }, [showSessionModal]);

  async function startSession() {
    try {
      // Get a session token for OpenAI Realtime API
      const tokenResponse = await fetch("/api/token");
      const data = await tokenResponse.json();
      
      if (data.error) {
        console.error("Error getting token:", data.error);
        return;
      }
      
      const EPHEMERAL_KEY = data.client_secret.value;

      // Create a peer connection
      const pc = new RTCPeerConnection();

      // Set up to play remote audio from the model
      audioElement.current = document.createElement("audio");
      audioElement.current.autoplay = true;
      pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

      // Add local audio track for microphone input in the browser
      const ms = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      pc.addTrack(ms.getTracks()[0]);

      // Set up data channel for sending and receiving events
      const dc = pc.createDataChannel("oai-events");
      setDataChannel(dc);

      // Start the session using the Session Description Protocol (SDP)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-mini-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp",
        },
      });

      const answer = {
        type: "answer",
        sdp: await sdpResponse.text(),
      };
      await pc.setRemoteDescription(answer);

      peerConnection.current = pc;
    } catch (error) {
      console.error("Error starting session:", error);
    }
  }

  // Stop current session, clean up peer connection and data channel
  function stopSession() {
    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    setDataChannel(null);
    peerConnection.current = null;
  }

  // Send a message to the model
  function sendClientEvent(message) {
    if (dataChannel) {
      const timestamp = new Date().toLocaleTimeString();
      message.event_id = message.event_id || crypto.randomUUID();

      // send event before setting timestamp since the backend peer doesn't expect this field
      dataChannel.send(JSON.stringify(message));

      // if guard just in case the timestamp exists by miracle
      if (!message.timestamp) {
        message.timestamp = timestamp;
      }
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message,
      );
    }
  }

  // Send a text message to the model and share with the session
  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
    
    // Also send to all users in the session
    if (socket && sessionId) {
      socket.emit("send_message", {
        sessionId,
        message,
        aiResponse: null // This will be updated when AI responds
      });
    }
  }

  // Join a session
  function joinSession(sessionId, username) {
    if (!socket || !sessionId || !username) return;
    
    socket.emit("join_session", { sessionId, username });
    setSessionId(sessionId);
    setUsername(username);
    setShowSessionModal(false);
    startSession();
  }

  // Create a new session
  function createNewSession(newSessionId, username) {
    if (!socket || !newSessionId || !username) return;
    
    socket.emit("join_session", { sessionId: newSessionId, username });
    setSessionId(newSessionId);
    setUsername(username);
    setShowSessionModal(false);
    startSession();
  }

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    if (dataChannel) {
      // Append new server events to the list
      dataChannel.addEventListener("message", (e) => {
        const event = JSON.parse(e.data);
        if (!event.timestamp) {
          event.timestamp = new Date().toLocaleTimeString();
        }

        setEvents((prev) => [event, ...prev]);
        
        // Check if this is an AI response and share with the session
        if (event.type === "conversation.item.text" && event.item.role === "assistant") {
          if (socket && sessionId) {
            socket.emit("send_message", {
              sessionId,
              message: null,
              aiResponse: event.item.content
            });
          }
        }
      });

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
      });
    }
  }, [dataChannel, sessionId, socket]);

  // Render the session join/create modal
  const renderSessionModal = () => {
    if (!showSessionModal) return null;
    
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white p-6 rounded-lg w-96">
          <h2 className="text-xl font-bold mb-4">Join or Create a Session</h2>
          
          <div className="mb-4">
            <label className="block mb-2">Username:</label>
            <input 
              type="text" 
              value={username} 
              onChange={(e) => setUsername(e.target.value)}
              className="w-full p-2 border rounded"
              placeholder="Enter your username"
            />
          </div>
          
          <div className="mb-4">
            <h3 className="font-semibold mb-2">Available Sessions:</h3>
            {availableSessions.length > 0 ? (
              <ul className="mb-2">
                {availableSessions.map(session => (
                  <li key={session.id} className="mb-2 p-2 border rounded hover:bg-gray-100 cursor-pointer flex justify-between items-center">
                    <span>{session.id}</span>
                    <span className="text-sm text-gray-500">{session.userCount} users</span>
                    <button 
                      onClick={() => joinSession(session.id, username)}
                      className="px-3 py-1 bg-blue-500 text-white rounded text-sm"
                      disabled={!username}
                    >
                      Join
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-gray-500 mb-2">No active sessions</p>
            )}
          </div>
          
          <div className="mb-4">
            <h3 className="font-semibold mb-2">Create New Session:</h3>
            <div className="flex gap-2">
              <input 
                type="text" 
                value={sessionId} 
                onChange={(e) => setSessionId(e.target.value)}
                className="flex-1 p-2 border rounded"
                placeholder="Enter session name"
              />
              <button 
                onClick={() => createNewSession(sessionId, username)}
                className="px-4 py-2 bg-green-500 text-white rounded"
                disabled={!sessionId || !username}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      {renderSessionModal()}
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-0 border-b border-solid border-gray-200">
          <img style={{ width: "24px" }} src={logo} />
          <h1>realtime console</h1>
          {sessionId && <span className="ml-4 text-sm text-gray-500">Session: {sessionId} ({connectedUsers.length} users)</span>}
        </div>
      </nav>
      <main className="absolute top-16 left-0 right-0 bottom-0">
        <section className="absolute top-0 left-0 right-[380px] bottom-0 flex">
          <section className="absolute top-0 left-0 right-0 bottom-32 px-4 overflow-y-auto">
            <EventLog events={events} />
          </section>
          <section className="absolute h-32 left-0 right-0 bottom-0 p-4">
            <SessionControls
              startSession={startSession}
              stopSession={stopSession}
              sendClientEvent={sendClientEvent}
              sendTextMessage={sendTextMessage}
              events={events}
              isSessionActive={isSessionActive}
            />
          </section>
        </section>
        <section className="absolute top-0 w-[380px] right-0 bottom-0 p-4 pt-0 overflow-y-auto">
          <ToolPanel
            sendClientEvent={sendClientEvent}
            sendTextMessage={sendTextMessage}
            events={events}
            isSessionActive={isSessionActive}
          />
          
          {/* Connected Users Panel */}
          {sessionId && (
            <div className="mt-4 border-t pt-4">
              <h3 className="font-bold mb-2">Connected Users</h3>
              <ul>
                {connectedUsers.map((user, index) => (
                  <li key={index} className="py-1">
                    {user === username ? `${user} (you)` : user}
                  </li>
                ))}
              </ul>
            </div>
          )}
          
          {/* Session Chat Panel */}
          {sessionId && (
            <div className="mt-4 border-t pt-4">
              <h3 className="font-bold mb-2">Session Chat</h3>
              <div className="h-64 overflow-y-auto border p-2 mb-2">
                {messages.map((msg, index) => (
                  <div key={index} className="mb-2">
                    <div className="font-bold">{msg.username === username ? 'You' : msg.username}:</div>
                    {msg.message && <div>{msg.message}</div>}
                    {msg.aiResponse && <div className="text-green-600">{msg.aiResponse}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
