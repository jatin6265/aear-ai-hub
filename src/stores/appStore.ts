import { create } from 'zustand';

interface AppState {
  sidebarOpen: boolean;
  currentTenantId: string | null;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setCurrentTenantId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  currentTenantId: null,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setCurrentTenantId: (id) => set({ currentTenantId: id }),
}));
