export function edgeStyleForType(type?: string): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
  const stroke = type === "error" ? "#ef4444" : type === "loop" ? "#f59e0b" : "#4b5563";
  return {
    stroke,
    strokeWidth: 2,
    ...(type === "loop" ? { strokeDasharray: "5 3" } : {}),
  };
}
