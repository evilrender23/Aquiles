import "@aquiles/ui/estilos.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EntradaRapida } from "./componentes/EntradaRapida";
import "./estilos.css";

// La ventana del atajo global carga la misma página con ?vista=rapida.
const rapida = new URLSearchParams(location.search).get("vista") === "rapida";
if (rapida) document.documentElement.classList.add("ventana-rapida");

createRoot(document.getElementById("raiz")!).render(<StrictMode>{rapida ? <EntradaRapida /> : <App />}</StrictMode>);
