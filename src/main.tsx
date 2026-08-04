import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@git-diff-view/react/styles/diff-view.css";
import "./index.css";
import App from "./App.jsx";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
