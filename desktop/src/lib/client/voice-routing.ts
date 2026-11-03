export interface VoiceTicket {
  id: string;
  assistantName?: string;
}

export function workspaceVoiceCommand(text: string): 'status' | 'pause' | 'resume' | null {
  const command = text
    .trim()
    .toLowerCase()
    .replace(/[,.!?]/g, '')
    .replace(/^hey gantry\s+/, '');
  if (/^(everyone'?s status|status of (everyone|all tickets)|what'?s (everyone|every ticket) doing)$/.test(command)) return 'status';
  const control = command.match(/^(pause|resume) (everyone|all tickets|all workflows)$/);
  return control ? (control[1] as 'pause' | 'resume') : null;
}

/** Require a name for ambient input, and never guess when a first name is shared. */
export function routeVoice(text: string, tickets: VoiceTicket[], selectedId: string, ambient = false) {
  const addressed = text.trim().match(/^hey\s+(.+)$/i);
  if (!addressed) {
    if (ambient) return null;
    return { ticketId: selectedId, text: text.trim() };
  }

  const rest = addressed[1];
  const matches = tickets.flatMap((ticket) => {
    const name = ticket.assistantName || '';
    const aliases = [...new Set([name, name.split(' ')[0]])].filter(Boolean);
    return aliases.flatMap((alias) => {
      if (rest.slice(0, alias.length).toLowerCase() !== alias.toLowerCase()) return [];
      const suffix = rest.slice(alias.length);
      if (suffix && !/^[\s,.!?]/.test(suffix)) return [];
      return [{ ticketId: ticket.id, text: suffix.replace(/^[\s,.!?]+/, ''), length: alias.length }];
    });
  });
  const longest = Math.max(0, ...matches.map((match) => match.length));
  const best = matches.filter((match) => match.length === longest);
  if (best.length !== 1) throw new Error('Use the assistant’s full name or select a ticket; that name is unknown or shared.');
  return { ticketId: best[0].ticketId, text: best[0].text || 'Where does this ticket stand, and does anything need me?' };
}
