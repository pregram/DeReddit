// TransactionContext is a global non-blocking pending tray (ADR-001 Option
// C). WalletTxBridge must render inside both providers - see its own
// comment for what it wires.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.tsx'
import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css';
import { Notifications } from '@mantine/notifications'
import '@mantine/notifications/styles.css';
import '@fontsource-variable/inter';
import './styles/interactive.css';
import { WalletProvider } from './context/WalletContext'
import { TransactionProvider } from './context/TransactionContext'
import { WalletTxBridge } from './components/WalletTxBridge'
import { theme, cssVariablesResolver } from './theme'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} defaultColorScheme="light">
      <Notifications
        position="top-right"
        styles={{
          notification: {
            fontSize: "var(--mantine-font-size-md)",
            padding: "var(--mantine-spacing-md)",
            backdropFilter: "blur(8px)",
            backgroundColor: "var(--mantine-color-body)",
            color: "var(--mantine-color-text)",
          },
        }}
      />
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <WalletProvider>
          <TransactionProvider>
            <WalletTxBridge />
            <App />
          </TransactionProvider>
        </WalletProvider>
      </BrowserRouter>
    </MantineProvider>
  </StrictMode>,
)