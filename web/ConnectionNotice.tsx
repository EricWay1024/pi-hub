import React from 'react';
import { HUB_UNREACHABLE } from './api';

export function RefreshButton({ refresh }: { refresh: () => void }) {
  return <button type="button" onClick={refresh} title="Refresh the workspace connection">↻ Refresh</button>;
}

export function ConnectionNotice({ failed, refresh }: { failed: boolean; refresh: () => void }) {
  return <div className="connection-notice" role={failed ? 'alert' : 'status'}>
    <div><strong>{failed ? 'Workspace connection lost' : 'Connecting to Pi Hub…'}</strong>
      {failed && <><p>{HUB_UNREACHABLE} Retrying automatically.</p><p>Displayed agents and messages may be out of date. Commands are not resent; check history before submitting again.</p></>}
    </div><RefreshButton refresh={refresh}/>
  </div>;
}

export function WorkspaceUnavailable({ message, refresh }: { message: string; refresh: () => void }) {
  return <div className="login"><section className="login-card" aria-labelledby="unavailable-title">
    <span className="logo">π</span><h1 id="unavailable-title">Workspace unavailable</h1>
    <p role="alert">{message}</p><RefreshButton refresh={refresh}/>
  </section></div>;
}
