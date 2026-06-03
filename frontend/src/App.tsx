import { useState } from 'react'
import Header from './components/Header'
import Firewall from './pages/Firewall'
import Topology from './pages/Topology'
import Logs from './pages/Logs'
import AiChat from './pages/AiChat'
import Settings from './pages/Settings'
import Toast from './components/Toast'

export type Tab = 'firewall' | 'topology' | 'logs' | 'ai' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'firewall', label: 'Firewall' },
  { id: 'topology', label: 'Topology' },
  { id: 'logs',     label: 'Logs'     },
  { id: 'ai',       label: 'AI Chat'  },
  { id: 'settings', label: 'Settings' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('firewall')

  return (
    <>
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