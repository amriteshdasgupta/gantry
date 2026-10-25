import { api } from './api';
import type { ProjectView, TicketView } from './gantry';

/** Resolve review ownership before committing the selected workspace to UI state. */
export function selectedWorkspaceId(
  projects: Pick<ProjectView, 'id'>[],
  tickets: Pick<TicketView, 'projectId' | 'reviewSpaceId'>[],
  projectId: string,
  reviewSpace: string | null,
): string {
  const owner = reviewSpace ? tickets.find(ticket => ticket.reviewSpaceId === reviewSpace) : undefined;
  const requested = owner?.projectId ?? projectId;

  return projects.find(project => project.id === requested)?.id ?? projects[0]?.id ?? projectId;
}

/** Never let an unlinked workspace review fall back to the global current space. */
export async function openWorkspaceReview(
  urls: string[],
  workspaceName: string,
  ticketSpace?: string,
): Promise<string | undefined> {
  let targetSpace = ticketSpace;

  if (!targetSpace && urls.length) {
    targetSpace = (await api.createSpace(`${workspaceName} · Reviews`)).id;
  }

  for (const url of urls) {
    await api.addToSpace(url, targetSpace);
  }

  return targetSpace;
}
