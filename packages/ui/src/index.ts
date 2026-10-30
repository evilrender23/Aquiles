// Componentes de Aquiles con el sistema de diseño NOX. Los estilos van en "@aquiles/ui/estilos.css".
export { clases } from "./clases";
export { Icono, type NombreIcono, type PropsIcono } from "./componentes/Icono";
export { Boton, BotonIcono, type PropsBoton, type PropsBotonIcono, type VarianteBoton } from "./componentes/Boton";
export { Etiqueta, Titular, type PropsEtiqueta, type PropsTitular } from "./componentes/Texto";
export { Tarjeta, BloqueCodigo, Chip, Medidor, type PropsTarjeta, type PropsBloqueCodigo, type PropsChip, type PropsMedidor } from "./componentes/Tarjeta";
export { Campo, Selector, type OpcionSelector, type PropsCampo, type PropsSelector } from "./componentes/Formulario";
export { Desplegable, Opcion, GrupoOpciones, type PropsDesplegable, type PropsDisparador, type PropsOpcion } from "./componentes/Desplegable";
export { Interruptor, type PropsInterruptor } from "./componentes/Interruptor";
export { Pestanas, idPestana, type Pestana, type PropsPestanas } from "./componentes/Pestanas";
export { CampoBusqueda, type PropsCampoBusqueda } from "./componentes/Busqueda";

// Efectos de React Bits elegidos por el usuario (adaptados en el lienzo Aquiles · NOX).
export { LogoAscii } from "./efectos/LogoAscii";
export { LatticeLoader, ThoughtLine, type PropsThoughtLine } from "./efectos/Pensamiento";
export { BlurText, rehypeBlurText, trocearTokens } from "./efectos/BlurText";
export { BranchedMenu, type GrupoRamas, type PropsBranchedMenu } from "./efectos/BranchedMenu";
export { CrystalizedBall, type PropsCrystalizedBall } from "./efectos/CrystalizedBall";
export { GradientAscii, type FormaGradiente, type PropsGradientAscii } from "./efectos/GradientAscii";
