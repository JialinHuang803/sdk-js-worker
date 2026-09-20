import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ActivityAuthProvider } from "./shared/ActivityAuth";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActivityAuthProvider><App /></ActivityAuthProvider>
  </StrictMode>,
);
