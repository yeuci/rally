import { createContext, useContext } from 'react';

/** Controls of the app drawer (components/rally/app-drawer.tsx), provided by `(app)/_layout.tsx`. */
export type AppDrawerControls = {
  isOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
};

const NONE: AppDrawerControls = { isOpen: false, openDrawer: () => {}, closeDrawer: () => {} };

export const AppDrawerContext = createContext<AppDrawerControls>(NONE);

/** The drawer's open state and controls; inert outside `(app)` (no provider). */
export function useAppDrawer(): AppDrawerControls {
  return useContext(AppDrawerContext);
}
