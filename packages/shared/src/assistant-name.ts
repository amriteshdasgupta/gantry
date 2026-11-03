/** Stable, human names for existing tickets too; renaming a ticket never changes its assistant. */
export function assistantNameFor(id: string): string {
  const first = ['Alex', 'Maya', 'Theo', 'Nora', 'Leo', 'Aria', 'Sam', 'Iris', 'Owen', 'Zoe', 'Finn', 'Ada', 'Max', 'Lena', 'Eli', 'Ruby'];
  const last = ['Morgan', 'Reed', 'Hayes', 'Brooks', 'Lane', 'Quinn', 'Ellis', 'Parker', 'Blake', 'Rowan', 'Hart', 'Wells', 'Gray', 'Shaw', 'West', 'Stone'];
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return `${first[hash % first.length]} ${last[Math.floor(hash / first.length) % last.length]}`;
}
