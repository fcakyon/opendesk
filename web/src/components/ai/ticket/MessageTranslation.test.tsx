import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Message, Ticket } from '@/lib/api/types';
import { q } from '@/lib/queries';
import { i18n } from '@/i18n';
import { useMessageTranslation } from './MessageAi';

vi.mock('@/lib/ai',()=>({useAI:()=>({enabled:true})}));
vi.mock('@/lib/session',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/session')>(),useRole:()=> 'agent'}));

const ticket=(language:string|null):Ticket=>({
  id: "t",
  number: 1042,
  subject: "Order 1042",
  status: "open",
  priority: "high",
  severity: null,
  channel: "email",
  mailbox_id: "mb1",
  contact: null,
  assignee: null,
  team_id: "team1",
  brand_id: "b1",
  widget_id: null,
  origin_mailbox_id: "mb1",
  received_at: "support@margin.test",
  page_url: "",
  routed: null,
  required_skills: [],
  tags: [],
  fields: {},
  sla: null,
  first_responded_at: null,
  solved_at: null,
  snoozed_until: null,
  last_message_at: "2026-10-28T09:00:00Z",
  last_customer_message_at: null,
  waiting_since: null,
  unanswered_count: 0,
  last_message_preview: "",
  last_note: null,
  message_count: 1,
  spam: false,
  csat: null,
  custom: { language },
  created_at: "2026-10-28T09:00:00Z",
  updated_at: "2026-10-28T09:00:00Z",
});

async function offered(m:Message,language:string|null){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 await i18n.changeLanguage('en');
 const qc=new QueryClient({defaultOptions:{queries:{retry:false}}});
 qc.setQueryData<Ticket>(q.ticket("t").queryKey, ticket(language));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 function Probe(){const tr=useMessageTranslation(m);return <span data-offered={tr.offered} />}
 try{
  await act(async()=>root.render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>));
  return host.querySelector('span')?.getAttribute('data-offered');
 }finally{await act(async()=>root.unmount());host.remove();qc.clear();vi.unstubAllGlobals()}
}

it.each([null,'und','zxx','en','fr'])('offers translation unless the source language %s is known to match the reader',async language=>{
 const m={id:'m',ticket_id:'t',kind:'reply',direction:'inbound',body_html:'<p>Hello?</p>',body_text:'Hello?'} as Message;
 expect(await offered(m,language)).toBe(String(language!=='en'));
});

it.each([
 ["the AI agent's answer", {kind:'reply',direction:'outbound',ai:true}, true],
 ["a colleague's reply", {kind:'reply',direction:'outbound'}, true],
 ['a note', {kind:'note',direction:'outbound'}, false],
 ['a side conversation message', {kind:'note',direction:'outbound',thread_id:'th'}, false],
 ['a side conversation answer', {kind:'note',direction:'inbound',thread_id:'th'}, false],
] as const)("offers translating %s in a conversation in another language: %s",async (_name, extra, want)=>{
 const m={id:'m',ticket_id:'t',body_html:'<p>Ciao</p>',body_text:'Ciao',...extra} as unknown as Message;
 expect(await offered(m,'it')).toBe(String(want));
});

it("doesn't offer translating the team's reply in a conversation in the reader's language",async ()=>{
 const m={id:'m',ticket_id:'t',kind:'reply',direction:'outbound',body_html:'<p>Hi</p>',body_text:'Hi'} as Message;
 expect(await offered(m,'en')).toBe('false');
});
