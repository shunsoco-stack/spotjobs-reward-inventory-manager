import { useCallback, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from "react";
import type { WorkRecord } from "@/lib/core";
import type { AppData } from "@/lib/storage";

export type SyncPhase = "requesting" | "waiting" | "fetching" | "importing" | "pulling";
export type SyncImportMode = "all" | "future";
export type SyncNotice = { text: string; error?: boolean } | null;

export interface SpotJobsSyncHost {
  demo: boolean;
  online: boolean;
  ready: boolean;
  saving: boolean;
  data: AppData;
  personalRef: MutableRefObject<AppData>;
  persistedRef: MutableRefObject<AppData | null>;
  savingRef: MutableRefObject<boolean>;
  channel: MutableRefObject<BroadcastChannel | null>;
  setPersonal: Dispatch<SetStateAction<AppData>>;
  setStorageError: Dispatch<SetStateAction<string>>;
  setUndo: Dispatch<SetStateAction<AppData | null>>;
  setNotice: Dispatch<SetStateAction<SyncNotice>>;
  setView: (view: "settings" | string) => void;
}

export interface SpotJobsSyncApi {
  syncing: boolean;
  nativeInstallHint: string;
  connectionBusyLabel: string | null;
  homeWelcomeCta: ReactNode;
  renderHomeAction: (onSetup: () => void) => ReactNode;
  renderSettingsPanel: () => ReactNode;
  prepareSavedData: (next: AppData, record: WorkRecord, existed: boolean) => AppData;
  removeRecord: (data: AppData, recordId: string) => AppData;
}

const NATIVE_INSTALL_HINT = "JSONバックアップも引き続き利用できます。";

export function useSpotJobsSync(host: SpotJobsSyncHost): SpotJobsSyncApi {
  void host;
  const prepareSavedData = useCallback<SpotJobsSyncApi["prepareSavedData"]>((next) => next, []);
  const removeRecord = useCallback((data: AppData, recordId: string): AppData => ({
    ...data,
    records: data.records.filter(record => record.id !== recordId),
  }), []);
  const renderHomeAction = useCallback(() => null, []);
  const renderSettingsPanel = useCallback(() => null, []);

  return {
    syncing: false,
    nativeInstallHint: NATIVE_INSTALL_HINT,
    connectionBusyLabel: null,
    homeWelcomeCta: null,
    renderHomeAction,
    renderSettingsPanel,
    prepareSavedData,
    removeRecord,
  };
}
