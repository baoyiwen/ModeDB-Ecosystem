import type { ReactElement, ReactNode } from 'react';
import { RemoteModelDBClient } from '@mode-db/sdk';
import {
  useAppConfirm,
  useAppSelect,
  type AppConfirmOptions,
  type AppSelectOptions,
} from '@mode-db/data-ui';
import { DesignerComponent } from './base/designer-component.js';
import { pushLibraryToEngine } from '../sync/designer-push-sync.js';
import {
  importEngineCatalogIntoDesignerDb,
  readBusinessCatalog,
} from '../sync/engine-catalog-import.js';
import {
  getSessionToken,
  getStoredHost,
  getStoredPort,
  getStoredToken,
} from '../config/connection-prefs.js';
import { formatInteractionState } from '../utils/interaction-state-i18n.js';
import { interactionStateForToolMode } from '../utils/tool-mode-state.js';
import { formatLibraryLabel } from '../sync/library-registry.js';
import { isQueryDesignerMode } from '../managers/mode-manager.js';
import {
  IconCheckSquare,
  IconDocument,
  IconExport,
  IconForceLayout,
  IconGrid,
  IconSnap,
  IconHand,
  IconLayers,
  IconLink,
  IconLogout,
  IconPan,
  IconPlus,
  IconRedo,
  IconSave,
  IconSearch,
  IconTrash,
  IconUndo,
  IconUpload,
  IconRestore,
} from './designer-icons.js';

const QUERY_TOOL_REWIRE_LABEL = '\u5207\u6362\u5173\u7cfb';

function formatBackupBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadBackupBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function chooseBackupFile(): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.modeldb-backup.json,.json,application/json,application/octet-stream';
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('focus', handleWindowFocus);
      input.remove();
      resolve(file);
    };
    const handleWindowFocus = (): void => {
      window.setTimeout(() => finish(input.files?.[0] ?? null), 0);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    window.addEventListener('focus', handleWindowFocus, { once: true });
    input.click();
  });
}

export interface DesignerToolbarProps {
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  onDisconnected: () => void;
  requestConfirm: (options: AppConfirmOptions) => Promise<boolean>;
  requestSelect: (options: AppSelectOptions) => Promise<string | null>;
}

/**
 * 浮动圆形工具栏（顶/左/底）+ 断开连接；与参考图布局一致。
 */
export class DesignerToolbar extends DesignerComponent<
  DesignerToolbarProps,
  Record<string, never>
> {
  private i18nUnsub: (() => void) | undefined;
  private modesUnsub: (() => void) | undefined;
  private stateUnsub: (() => void) | undefined;
  private libraryUnsub: (() => void) | undefined;
  private asyncUnsub: (() => void) | undefined;

  override componentDidMount(): void {
    this.i18nUnsub = this.managers.i18n.subscribe(() => this.forceUpdate());
    this.modesUnsub = this.managers.modes.subscribe(() => this.forceUpdate());
    this.stateUnsub = this.managers.state.subscribe(() => this.forceUpdate());
    this.libraryUnsub = this.managers.config.subscribeLibrary(() => this.forceUpdate());
    this.asyncUnsub = this.managers.asyncOps.subscribe(() => this.forceUpdate());
  }

  override componentWillUnmount(): void {
    this.i18nUnsub?.();
    this.modesUnsub?.();
    this.stateUnsub?.();
    this.libraryUnsub?.();
    this.asyncUnsub?.();
  }

  override render(): ReactNode {
    const { state, i18n, data, config, modes, graphSync, asyncOps, notifications } = this.managers;
    const st = state.state;
    const client = config.remoteClient;
    const mode = modes.mode;
    const queryDesignerActive = isQueryDesignerMode(mode);
    const libName = config.activeLibraryName;
    const libTag =
      libName !== null
        ? formatLibraryLabel(
            { code: libName, name: config.activeLibraryNameI18n ?? { en: libName } },
            i18n.locale,
          )
        : null;
    const remoteBusy = asyncOps.isBusy;
    const host = getStoredHost('127.0.0.1');
    const port = getStoredPort(9090);
    const token = getSessionToken() ?? getStoredToken('');

    const reloadBusinessCatalog = async (): Promise<void> => {
      if (!client || !libName) {
        return;
      }
      const catalog = await readBusinessCatalog({
        host,
        port,
        token,
        businessDb: libName,
      });
      await importEngineCatalogIntoDesignerDb(client, libName, catalog);
      await data.loadLibraryCanvas(client, libName, catalog);
    };

    const disconnect = (): void => {
      client?.close();
      config.setRemoteClient(null, false);
      this.props.onDisconnected();
    };

    return (
      <div className="designer-float-layer" aria-hidden={false}>
        <div className="designer-float-top">
          <button
            type="button"
            className={`designer-mode-pill ${
              queryDesignerActive ? 'designer-mode-pill--inactive' : 'designer-mode-pill--active'
            }`}
            aria-pressed={!queryDesignerActive}
            onClick={() => {
              modes.setMode('select');
              state.transition(interactionStateForToolMode('select'));
            }}
          >
            {i18n.t('ui', 'modeModelDesigner')}
            {libTag ? <span className="designer-library-tag"> · {libTag}</span> : null}
          </button>
          <button
            type="button"
            className={`designer-mode-pill ${
              queryDesignerActive ? 'designer-mode-pill--active' : 'designer-mode-pill--inactive'
            }`}
            aria-pressed={queryDesignerActive}
            title={i18n.t('ui', 'modeQueryDesignerHint')}
            onClick={() => {
              modes.activateQueryDesigner();
              state.transition(interactionStateForToolMode('query-select'));
            }}
          >
            {i18n.t('ui', 'modeQueryDesigner')}
          </button>
        </div>

        <div className="designer-float-left">
          {queryDesignerActive ? (
            <>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'query-select' ? 'true' : 'false'}
                title={i18n.t('ui', 'queryToolSelect')}
                onClick={() => {
                  modes.setMode('query-select');
                  state.transition(interactionStateForToolMode('query-select'));
                }}
              >
                <IconHand />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'query-create' ? 'true' : 'false'}
                title={i18n.t('ui', 'queryToolCreate')}
                onClick={() => {
                  modes.setMode('query-create');
                  state.transition(interactionStateForToolMode('query-create'));
                }}
              >
                <IconPlus />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'query-rewire' ? 'true' : 'false'}
                title={QUERY_TOOL_REWIRE_LABEL}
                onClick={() => {
                  modes.setMode('query-rewire');
                  state.transition(interactionStateForToolMode('query-rewire'));
                }}
              >
                <IconLink />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'query-inspect' ? 'true' : 'false'}
                title={i18n.t('ui', 'queryToolInspect')}
                onClick={() => {
                  modes.setMode('query-inspect');
                  state.transition(interactionStateForToolMode('query-inspect'));
                }}
              >
                <IconDocument />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'query-preview' ? 'true' : 'false'}
                title={i18n.t('ui', 'queryToolPreview')}
                onClick={() => {
                  modes.setMode('query-preview');
                  state.transition(interactionStateForToolMode('query-preview'));
                }}
              >
                <IconSearch />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'select' ? 'true' : 'false'}
                title={i18n.t('ui', 'toolSelect')}
                onClick={() => {
                  modes.setMode('select');
                  state.transition(interactionStateForToolMode('select'));
                }}
              >
                <IconHand />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'add' ? 'true' : 'false'}
                title={i18n.t('ui', 'toolCreate')}
                onClick={() => {
                  modes.setMode('add');
                  state.transition(interactionStateForToolMode('add'));
                }}
              >
                <IconPlus />
              </button>
              <button
                type="button"
                className="designer-fab"
                title={i18n.t('ui', 'toolEdit')}
                disabled
              >
                <IconDocument />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'delete' ? 'true' : 'false'}
                title={i18n.t('ui', 'toolDelete')}
                onClick={() => {
                  modes.setMode('delete');
                  state.transition(interactionStateForToolMode('delete'));
                }}
              >
                <IconTrash />
              </button>
              <button
                type="button"
                className="designer-fab"
                title={i18n.t('ui', 'toolMulti')}
                disabled
              >
                <IconCheckSquare />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'page' ? 'true' : 'false'}
                title={i18n.t('ui', 'toolPageMode')}
                onClick={() => {
                  modes.setMode('page');
                  state.transition(interactionStateForToolMode('page'));
                }}
              >
                <IconLayers />
              </button>
              <button
                type="button"
                className="designer-fab"
                data-active={mode === 'link' ? 'true' : 'false'}
                title={i18n.t('ui', 'toolLinkHint')}
                onClick={() => {
                  modes.setMode('link');
                  state.transition(interactionStateForToolMode('link'));
                }}
              >
                <IconLink />
              </button>
            </>
          )}
        </div>

        <div className="designer-float-top-left">
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolPan')}
            disabled
          >
            <IconPan />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolZoom')}
            disabled
          >
            <IconSearch />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolUndo')}
            disabled
          >
            <IconUndo />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolRedo')}
            disabled
          >
            <IconRedo />
          </button>
          <button
            type="button"
            className="designer-fab"
            title={i18n.t('ui', 'toolSave')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('save') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
                await new Promise((resolve) => window.setTimeout(resolve, 0));
              }
              try {
                await asyncOps.run(
                  'save',
                  () =>
                    pushLibraryToEngine({
                      designerClient: client,
                      libraryCode: libName,
                      data,
                      graphSync,
                      host: getStoredHost('127.0.0.1'),
                      port: getStoredPort(9090),
                      token: getSessionToken() ?? getStoredToken(''),
                    }),
                  { detail: libName },
                );
              } catch {
                /* 失败态由右侧 toast 展示 */
              }
            }}
          >
            <IconSave />
          </button>
          <button
            type="button"
            className="designer-fab"
            title={i18n.t('ui', 'toolExport')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('pull') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              try {
                await asyncOps.run(
                  'pull',
                  async () => {
                    const token = getSessionToken() ?? getStoredToken('');
                    const catalog = await readBusinessCatalog({
                      host: getStoredHost('127.0.0.1'),
                      port: getStoredPort(9090),
                      token,
                      businessDb: libName,
                    });
                    await importEngineCatalogIntoDesignerDb(client, libName, catalog);
                    await data.loadLibraryCanvas(client, libName, catalog);
                  },
                  { detail: libName },
                );
              } catch {
                /* 失败态由右侧 toast 展示 */
              }
            }}
          >
            <IconExport />
          </button>
        </div>

        <div className="designer-float-top-right">
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'backupCreate')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('backupDatabase') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              try {
                await asyncOps.run(
                  'backupDatabase',
                  async () => {
                    const backup = await RemoteModelDBClient.createBackup({
                      host,
                      port,
                      token,
                      database: libName,
                      reason: 'manual',
                    });
                    return backup;
                  },
                  { detail: libName },
                );
              } catch {
                /* 失败态由 toast 展示 */
              }
            }}
          >
            <IconDocument />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'backupRestore')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('restoreDatabase') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              let operationStarted = false;
              try {
                const backups = await RemoteModelDBClient.listBackups({
                  host,
                  port,
                  token,
                  database: libName,
                });
                if (backups.length === 0) {
                  notifications.warning(i18n.t('ui', 'backupRestore'), {
                    message: i18n.t('ui', 'backupEmpty'),
                  });
                  return;
                }
                const backupFile = await this.props.requestSelect({
                  title: i18n.t('ui', 'backupRestoreSelectTitle'),
                  message: i18n.t('ui', 'backupFileCount', { count: String(backups.length) }),
                  confirmLabel: i18n.t('ui', 'backupRestoreAction'),
                  initialValue: backups[0]?.fileName,
                  items: backups.map((backup) => ({
                    value: backup.fileName,
                    label: backup.fileName,
                    description: new Date(backup.createdAt).toLocaleString(i18n.locale),
                    meta: formatBackupBytes(backup.bytes),
                  })),
                });
                if (!backupFile) {
                  return;
                }
                if (
                  !(await this.props.requestConfirm({
                    title: i18n.t('ui', 'backupRestoreConfirm', { file: backupFile }),
                    tone: 'danger',
                  }))
                ) {
                  return;
                }
                operationStarted = true;
                await asyncOps.run(
                  'restoreDatabase',
                  async () => {
                    await RemoteModelDBClient.restoreBackup({
                      host,
                      port,
                      token,
                      database: libName,
                      backupFile,
                    });
                    await reloadBusinessCatalog();
                  },
                  { detail: libName },
                );
              } catch (error) {
                if (!operationStarted) {
                  notifications.error(i18n.t('errors', 'databaseManagementFailed'), {
                    message: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }}
          >
            <IconRestore />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'backupExport')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('exportBackup') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              let operationStarted = false;
              try {
                const backups = await RemoteModelDBClient.listBackups({
                  host,
                  port,
                  token,
                  database: libName,
                });
                if (backups.length === 0) {
                  notifications.warning(i18n.t('ui', 'backupExport'), {
                    message: i18n.t('ui', 'backupEmpty'),
                  });
                  return;
                }
                const backupFile = await this.props.requestSelect({
                  title: i18n.t('ui', 'backupExportSelectTitle'),
                  message: i18n.t('ui', 'backupFileCount', { count: String(backups.length) }),
                  confirmLabel: i18n.t('ui', 'backupExportAction'),
                  initialValue: backups[0]?.fileName,
                  items: backups.map((backup) => ({
                    value: backup.fileName,
                    label: backup.fileName,
                    description: new Date(backup.createdAt).toLocaleString(i18n.locale),
                    meta: formatBackupBytes(backup.bytes),
                  })),
                });
                if (!backupFile) {
                  return;
                }
                operationStarted = true;
                await asyncOps.run(
                  'exportBackup',
                  async () => {
                    const blob = await RemoteModelDBClient.downloadBackup({
                      host,
                      port,
                      token,
                      backupFile,
                    });
                    downloadBackupBlob(blob, backupFile);
                  },
                  { detail: backupFile },
                );
              } catch (error) {
                if (!operationStarted) {
                  notifications.error(i18n.t('errors', 'databaseManagementFailed'), {
                    message: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }}
          >
            <IconExport />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'backupImport')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('importBackup') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              const file = await chooseBackupFile();
              if (!file) {
                return;
              }
              if (
                !(await this.props.requestConfirm({
                  title: i18n.t('ui', 'backupImportConfirm', { file: file.name }),
                  message: i18n.t('ui', 'backupImportHint'),
                  tone: 'danger',
                }))
              ) {
                return;
              }
              try {
                await asyncOps.run(
                  'importBackup',
                  async () => {
                    const imported = await RemoteModelDBClient.importBackup({
                      host,
                      port,
                      token,
                      fileName: file.name,
                      file,
                    });
                    await RemoteModelDBClient.restoreBackup({
                      host,
                      port,
                      token,
                      database: libName,
                      backupFile: imported.fileName,
                    });
                    await reloadBusinessCatalog();
                  },
                  { detail: file.name },
                );
              } catch {
                /* Failure state is shown by the async operation toast. */
              }
            }}
          >
            <IconUpload />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'backupClear')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('clearDatabaseManaged') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              if (
                !(await this.props.requestConfirm({
                  title: i18n.t('ui', 'backupClearConfirm', { db: libName }),
                  tone: 'danger',
                }))
              ) {
                return;
              }
              try {
                await asyncOps.run(
                  'clearDatabaseManaged',
                  async () => {
                    await RemoteModelDBClient.clearDatabaseData({
                      host,
                      port,
                      token,
                      database: libName,
                    });
                    await reloadBusinessCatalog();
                  },
                  { detail: libName },
                );
              } catch {
                /* 失败态由 toast 展示 */
              }
            }}
          >
            <IconTrash />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'backupForceReset')}
            disabled={!client || !libName || remoteBusy}
            data-busy={asyncOps.isActive('forceResetDatabase') ? 'true' : undefined}
            onClick={async () => {
              if (!client || !libName || remoteBusy) {
                return;
              }
              if (
                !(await this.props.requestConfirm({
                  title: i18n.t('ui', 'backupForceResetConfirm', { db: libName }),
                  tone: 'danger',
                }))
              ) {
                return;
              }
              try {
                await asyncOps.run(
                  'forceResetDatabase',
                  async () => {
                    await RemoteModelDBClient.clearDatabaseData({
                      host,
                      port,
                      token,
                      database: libName,
                      forceReset: true,
                    });
                    await reloadBusinessCatalog();
                  },
                  { detail: libName },
                );
              } catch {
                /* 失败态由 toast 展示 */
              }
            }}
          >
            <IconForceLayout />
          </button>
        </div>

        <div className="designer-float-bottom">
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolForceLayout')}
            data-active={config.forceLayoutEnabled}
            onClick={() => {
              config.forceLayoutEnabled = !config.forceLayoutEnabled;
              this.forceUpdate();
            }}
          >
            <IconForceLayout />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolSnap')}
            data-active={config.snapToGrid}
            onClick={() => {
              config.snapToGrid = !config.snapToGrid;
              this.forceUpdate();
            }}
          >
            <IconSnap />
          </button>
          <button
            type="button"
            className="designer-fab designer-fab--ghost"
            title={i18n.t('ui', 'toolGrid')}
            data-active={config.gridEnabled}
            onClick={() => {
              config.gridEnabled = !config.gridEnabled;
              this.forceUpdate();
            }}
          >
            <IconGrid />
          </button>
        </div>

        <button
          type="button"
          className="designer-fab designer-float-exit"
          title={i18n.t('ui', 'disconnect')}
          onClick={disconnect}
        >
          <IconLogout />
        </button>

        <div className="designer-status-card" data-connected={client && libName ? 'true' : 'false'}>
          <span className="designer-status-card__dot" aria-hidden />
          <span className="designer-status-card__body">
            {libTag ? <span className="designer-status-card__database">{libTag}</span> : null}
            <span className="designer-status-card__state">
              {i18n.t('ui', 'stateLabel')}: {formatInteractionState(i18n, st)}
            </span>
          </span>
        </div>
      </div>
    );
  }
}

export function DesignerToolbarWithConfirm(
  props: Omit<DesignerToolbarProps, 'requestConfirm' | 'requestSelect'>,
): ReactElement {
  const confirm = useAppConfirm();
  const select = useAppSelect();
  return <DesignerToolbar {...props} requestConfirm={confirm} requestSelect={select} />;
}
