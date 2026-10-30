import { aplicarDescuento, precioConIva } from "./precios";
import { capitalizar, formatearFecha, invertirCadena } from "./util";

export interface Pedido {
  cliente: string;
  fecha: string;
  base: number;
  descuento?: number;
}

export function resumenPedido(p: Pedido): string {
  const conIva = precioConIva(p.base);
  const final = p.descuento ? aplicarDescuento(conIva, p.descuento) : conIva;
  const codigoAntiguo = `${p.cliente.slice(0, 3).toUpperCase()}-${p.fecha.replaceAll("-", "")}`;
  return `${capitalizar(p.cliente)} · ${formatearFecha(p.fecha)} · ${final.toFixed(2)} €`;
}
