export type TicketClass = 'online' | 'offline';
export type TicketState = 'waiting' | 'promoted' | 'transferred' | 'failed' | 'expired';

export interface QueueTicket {
  id: string;
  targetId: string;
  playerUuid: string;
  playerName?: string;
  ticketClass: TicketClass;
  state: TicketState;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastSnapshot?: string;
}

export interface QueueSummary {
  online: { count: number; position?: number };
  offline: { count: number; position?: number };
}

export function summarizeTickets(tickets: QueueTicket[], playerUuid?: string): QueueSummary {
  const active = tickets
    .filter((ticket) => ticket.state === 'waiting' || ticket.state === 'promoted')
    .sort((a, b) => a.sequence - b.sequence);
  const online = active.filter((ticket) => ticket.ticketClass === 'online');
  const offline = active.filter((ticket) => ticket.ticketClass === 'offline');
  return {
    online: { count: online.length, position: playerUuid ? online.findIndex((t) => t.playerUuid === playerUuid) + 1 || undefined : undefined },
    offline: { count: offline.length, position: playerUuid ? offline.findIndex((t) => t.playerUuid === playerUuid) + 1 || undefined : undefined },
  };
}
