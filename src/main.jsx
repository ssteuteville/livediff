import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@git-diff-view/react/styles/diff-view.css";
import "./index.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
