import { createContext, useContext, type ReactNode } from "react";
import type { AppController } from "@/hooks/app-controller";

const ControllerContext = createContext<AppController | null>(null);

export function ControllerProvider({ controller, children }: { controller: AppController; children: ReactNode }) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

/** The app controller; only valid below `ControllerProvider`. */
export function useController(): AppController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("useController must be used inside ControllerProvider");
  return controller;
}
