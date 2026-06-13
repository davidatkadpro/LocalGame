import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./ui/styles.css";

// Note: no StrictMode — its dev double-mount races PixiJS's async init/destroy.
createRoot(document.getElementById("root")!).render(<App />);
