import { describe, expect, test } from 'vitest';
import { routeVoice, workspaceVoiceCommand } from '../desktop/src/lib/client/voice-routing';

const tickets = [
  { id: 'one', assistantName: 'Maya Reed' },
  { id: 'two', assistantName: 'Maya Morgan' },
  { id: 'three', assistantName: 'Theo Ellis' },
];

describe('workspace voice routing', () => {
  test('full names win over first names and punctuation is stripped from the request', () => {
    expect(routeVoice('Hey Maya Reed, what needs me?', tickets, 'three')).toEqual({ ticketId: 'one', text: 'what needs me?' });
    expect(routeVoice('hey theo pause the workflow', tickets, 'one')).toEqual({ ticketId: 'three', text: 'pause the workflow' });
  });

  test('unknown and ambiguous names never select a different ticket', () => {
    expect(() => routeVoice('Hey Maya, resume', tickets, 'one')).toThrow(/full name/);
    expect(() => routeVoice('Hey Theodore, resume', tickets, 'one')).toThrow(/unknown/);
  });

  test('ambient audio requires addressing; explicit input can use the selected ticket', () => {
    expect(routeVoice('pause the workflow', tickets, 'one', true)).toBeNull();
    expect(routeVoice('pause the workflow', tickets, 'one')).toEqual({ ticketId: 'one', text: 'pause the workflow' });
    expect(routeVoice('Hey Theo', tickets, 'one', true)?.text).toContain('Where does this ticket stand');
  });

  test('workspace controls only recognize a small explicit vocabulary', () => {
    expect(workspaceVoiceCommand('Hey Gantry, pause everyone.')).toBe('pause');
    expect(workspaceVoiceCommand('Resume all tickets!')).toBe('resume');
    expect(workspaceVoiceCommand('Everyone’s status'.replace('’', "'"))).toBe('status');
    expect(workspaceVoiceCommand('Do not pause everyone')).toBeNull();
    expect(workspaceVoiceCommand('merge everyone')).toBeNull();
  });
});
