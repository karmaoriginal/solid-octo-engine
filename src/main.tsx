import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Sin StrictMode a propósito: el motor 3D + worker se crean una sola vez sobre el mismo canvas.
createRoot(document.getElementById("root")!).render(<App />);
