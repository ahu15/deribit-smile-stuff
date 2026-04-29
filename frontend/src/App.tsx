import { DockShell } from './shell/DockShell';
import { ThemeProvider } from './hooks/useTheme';

export default function App() {
  return (
    <ThemeProvider>
      <div style={{
        height: '100vh',
        background: 'var(--bg)',
        color: 'var(--fg)',
        fontFamily: 'var(--font-chrome)',
        overflow: 'hidden',
      }}>
        <DockShell />
      </div>
    </ThemeProvider>
  );
}
