import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import react from "@vitejs/plugin-react";

const path = fileURLToPath(import.meta.url);

export default {
  root: join(dirname(path), "client"),
  plugins: [react()],
  build: {
    outDir: resolve(dirname(path), "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: join(dirname(path), "client/index.html"),
      },
    },
    assetsDir: "assets",
  },
};
