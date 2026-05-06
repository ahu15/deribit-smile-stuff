import { DockShell } from './shell/DockShell';
import { ThemeProvider } from './hooks/useTheme';
import { DefaultModelProvider } from './hooks/useDefaultModel';

export default function App() {
  return (
    <ThemeProvider>
      <DefaultModelProvider>
        <div style={{
          height: '100vh',
          background: 'var(--bg)',
          color: 'var(--fg)',
          fontFamily: 'var(--font-chrome)',
          overflow: 'hidden',
        }}>
          <DockShell />
        </div>
      </DefaultModelProvider>
    </ThemeProvider>
  );
}
