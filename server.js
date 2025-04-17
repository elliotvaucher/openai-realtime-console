import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";
import { Server } from "socket.io";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;

// Serve static files from the Vite build output directory
app.use(express.static(path.join(__dirname, 'dist/client')));

// Track active sessions and users
const activeSessions = {};

// Socket.io connection handling for multi-user chat
io.on("connection", (socket) => {
  let currentSession = null;
  let currentUser = null;
  
  socket.on("join_session", ({ sessionId, username }) => {
    currentSession = sessionId;
    currentUser = username;
    
    // Create session if it doesn't exist
    if (!activeSessions[sessionId]) {
      activeSessions[sessionId] = {
        users: {},
        messages: []
      };
    }
    
    // Add user to session
    activeSessions[sessionId].users[socket.id] = username;
    
    // Join socket room
    socket.join(sessionId);
    
    // Notify everyone in the session
    io.to(sessionId).emit("user_joined", { 
      username,
      users: Object.values(activeSessions[sessionId].users)
    });
    
    // Send session history to new user
    socket.emit("session_history", activeSessions[sessionId].messages);
  });
  
  socket.on("send_message", ({ sessionId, message, aiResponse }) => {
    if (!activeSessions[sessionId]) return;
    
    const username = activeSessions[sessionId].users[socket.id];
    const messageData = {
      id: Date.now(),
      username,
      message,
      aiResponse,
      timestamp: new Date().toISOString()
    };
    
    // Store message in session history
    activeSessions[sessionId].messages.push(messageData);
    
    // Broadcast to all in the session
    io.to(sessionId).emit("new_message", messageData);
  });
  
  socket.on("disconnect", () => {
    if (currentSession && activeSessions[currentSession]) {
      // Remove user from session
      if (activeSessions[currentSession].users[socket.id]) {
        const username = activeSessions[currentSession].users[socket.id];
        delete activeSessions[currentSession].users[socket.id];
        
        // Notify others that user left
        io.to(currentSession).emit("user_left", { 
          username,
          users: Object.values(activeSessions[currentSession].users)
        });
        
        // Clean up empty sessions
        if (Object.keys(activeSessions[currentSession].users).length === 0) {
          delete activeSessions[currentSession];
        }
      }
    }
  });
});

// API route for token generation
app.get("/api/token", async (req, res) => {
  try {
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }
    
    const response = await fetch(
      "https://api.openai.com/v1/realtime/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-realtime-preview-2024-12-17",
          voice: "verse",
        }),
      },
    );

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// API endpoint to get available sessions
app.get("/api/sessions", (req, res) => {
  const sessionList = Object.keys(activeSessions).map(sessionId => ({
    id: sessionId,
    userCount: Object.keys(activeSessions[sessionId].users).length
  }));
  
  res.json(sessionList);
});

// Handle all other routes for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/client', 'index.html'));
});

// Check if running in a local environment
if (process.env.NODE_ENV !== 'production') {
  // In development, start the server
  server.listen(port, () => {
    console.log(`Server running on *:${port}`);
  });
}

export default app;
