import { useState } from 'react'
import Header from './components/Header'
import AuditLog from './pages/AuditLog'
import Firewall from './pages/Firewall'
import Topology from './pages/Topology'
import AiChat from './pages/AiChat'
import Settings from './pages/Settings'
import Toast from './components/Toast'

export type Tab = 'audit' | 'firewall' | 'topology' | 'ai' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'audit',    label: 'Audit Log'  },
  { id: 'firewall', label: 'Firewall'   },
  { id: 'topology', label: 'Topology'   },
  { id: 'ai',       label: 'AI Chat'    },
  { id: 'settings', label: 'Settings'   },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('audit')

  return (
    <>
      <Header activeTab={tab} tabs={TABS} onTabChange={setTab} />
      <main>
        {tab === 'audit'    && <AuditLog />}
        {tab === 'firewall' && <Firewall />}
        {tab === 'topology' && <Topology />}
        {tab === 'ai'       && <AiChat />}
        {tab === 'settings' && <Settings />}
      </main>
      <Toast />
    </>
  )
}