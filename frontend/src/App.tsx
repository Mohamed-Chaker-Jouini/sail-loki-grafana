import { useState } from 'react'
import Header from './components/Header'
import Firewall from './pages/Firewall'
import Topology from './pages/Topology'
import Logs from './pages/Logs'
import AiChat from './pages/AiChat'
import Settings from './pages/Settings'
import Toast from './components/Toast'
import Login from './pages/Login' // Adjust path if needed

export type Tab = 'firewall' | 'topology' | 'logs' | 'ai' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'firewall', label: 'Firewall' },
  { id: 'topology', label: 'Topology' },
  { id: 'logs',     label: 'Logs'     },
  { id: 'ai',       label: 'AI Chat'  },
  { id: 'settings', label: 'Settings' },
]

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [tab, setTab] = useState<Tab>('firewall')

  // Render Login screen if not authenticated
  if (!isLoggedIn) {
    return <Login onLogin={() => setIsLoggedIn(true)} />
  }

  // Render main app once authenticated
  return (
    <>
      {/* If you want a logout button in your header, you could pass setIsLoggedIn(false) down as a prop */}
      <Header activeTab={tab} tabs={TABS} onTabChange={setTab} />
      <main>
        {tab === 'firewall' && <Firewall />}
        {tab === 'topology' && <Topology />}
        {tab === 'logs'     && <Logs />}
        {tab === 'ai'       && <AiChat />}
        {tab === 'settings' && <Settings />}
      </main>
      <Toast />
    </>
  )
}