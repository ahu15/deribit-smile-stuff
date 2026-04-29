import { DockShell } from './shell/DockShell';

export default function App() {
  return (
    <div style={{
      height: '100vh',
      background: '#0d0d1a',
      color: '#e0e0e0',
      fontFamily: 'ui-monospace, monospace',
      overflow: 'hidden',
    }}>
      <DockShell />
    </div>
  );
}
