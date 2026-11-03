import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Space, SpacesResponse } from "@/lib/types";
import { HOME } from "./exec";
import type { StatusView } from "@/lib/client/gantry";
import { parseGithub } from "@/lib/github-url";
import type { TicketOutputs } from "./ticket-outputs";
import { SPACE_COLORS, SPACE_EMOJI, spaceStyle } from "@/lib/space-style";

const FILE = path.join(HOME, "spaces.json");

function newSpace(name: string, taken: Space[] = []): Space {
  // A colour and emoji nobody else is using yet, where possible.
  const used = new Set(taken.map((s) => spaceStyle(s).color));
  const color = SPACE_COLORS.find((c) => !used.has(c)) ?? SPACE_COLORS[taken.length % SPACE_COLORS.length];
  const usedEmoji = new Set(taken.map((s) => spaceStyle(s).emoji));
  const free = SPACE_EMOJI.filter((e) => !usedEmoji.has(e));
  const pool = free.length ? free : SPACE_EMOJI;
  const emoji = pool[Math.floor(Math.random() * pool.length)];
  return { id: randomUUID().slice(0, 8), name, targets: [], active: null, files: {}, color, emoji, updatedAt: Date.now() };
}

function read(): SpacesResponse {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as SpacesResponse;
    if (data.spaces.length) {
      if (!data.spaces.some((s) => s.id === data.current && !s.gantry?.completed)) data.current = data.spaces.find(s => !s.gantry?.completed)?.id ?? "";
      for (const s of data.spaces) s.files ??= {};
      return data;
    }
  } catch {
    /* first run, or unreadable: start fresh */
  }
  const first = newSpace("My reviews");
  return { spaces: [first], current: first.id };
}

function write(data: SpacesResponse): SpacesResponse {
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(data, null, 1));
  fs.renameSync(`${FILE}.tmp`, FILE);
  return data;
}

const notFound = (id: string) => Object.assign(new Error(`No space "${id}"`), { status: 404 });

export function listSpaces(): SpacesResponse {
  const data = read();
  data.spaces = data.spaces.filter(s => !s.gantry?.completed);
  if (!data.spaces.some(s => s.id === data.current)) data.current = data.spaces[0]?.id ?? "";
  return data;
}

export function createSpace(name?: string): Space {
  const data = read();
  const space = newSpace(name?.trim() || `Space ${data.spaces.length + 1}`, data.spaces);
  data.spaces.push(space);
  data.current = space.id;
  write(data);
  return space;
}

export interface SpacePatch {
  name?: string;
  active?: string | null;
  targets?: string[];
  file?: { target: string; path: string };
  makeCurrent?: boolean;
  color?: string;
  emoji?: string;
}

export function updateSpace(id: string, patch: SpacePatch): Space {
  const data = read();
  const space = data.spaces.find((s) => s.id === id);
  if (!space || space.gantry?.completed) throw notFound(id);
  if (patch.name !== undefined && patch.name.trim()) space.name = patch.name.trim();
  if (patch.targets) {
    space.targets = [...new Set(patch.targets)];
    for (const t of Object.keys(space.files)) if (!space.targets.includes(t)) delete space.files[t];
    if (space.active && !space.targets.includes(space.active)) space.active = space.targets[0] ?? null;
  }
  if (patch.active !== undefined && (patch.active === null || space.targets.includes(patch.active))) space.active = patch.active;
  if (patch.file && space.targets.includes(patch.file.target)) space.files[patch.file.target] = patch.file.path;
  if (patch.makeCurrent) data.current = id;
  if (patch.color && (SPACE_COLORS as readonly string[]).includes(patch.color)) space.color = patch.color;
  // Keep one emoji (a single grapheme, so flags and skin tones survive).
  const emoji = patch.emoji?.trim() ? [...new Intl.Segmenter().segment(patch.emoji.trim())][0]?.segment : undefined;
  if (emoji) space.emoji = emoji;
  space.updatedAt = Date.now();
  write(data);
  return space;
}

/** Add a target to a space (the current one by default) and open its tab. */
export function addToSpace(target: string, spaceId?: string, file?: string | null): Space {
  const data = read();
  const space = data.spaces.find((s) => s.id === (spaceId ?? data.current));
  if (!space || space.gantry?.completed) throw notFound(spaceId ?? data.current);
  if (!space.targets.includes(target)) space.targets.push(target);
  space.active = target;
  if (file) space.files[target] = file;
  space.updatedAt = Date.now();
  data.current = space.id;
  write(data);
  return space;
}

export function deleteSpace(id: string): SpacesResponse {
  const data = read();
  if (!data.spaces.some((s) => s.id === id)) throw notFound(id);
  if (data.spaces.filter(s => !s.gantry?.completed).length === 1) throw Object.assign(new Error("Keep at least one space."), { status: 400 });
  data.spaces = data.spaces.filter((s) => s.id !== id);
  if (data.current === id) data.current = data.spaces.find(s => !s.gantry?.completed)!.id;
  write(data);
  return listSpaces();
}

/** Drop a removed workspace's ticket spaces, returning what they were reviewing. */
export function forgetWorkspaceSpaces(projectId: string): string[] {
  const data = read();
  const gone = data.spaces.filter(s => s.gantry?.projectId === projectId);
  if (!gone.length) return [];
  data.spaces = data.spaces.filter(s => s.gantry?.projectId !== projectId);
  write(data);
  return gone.flatMap(s => s.targets);
}

/** Provision one stable space per workspace/ticket, keeping historical PRs and review state. */
export function syncGantrySpaces(status: StatusView, outputs: Record<string, TicketOutputs> = {}): Record<string, string> {
  const data = read();
  let changed = false;
  const result: Record<string, string> = {};
  // A removed workspace's spaces hide until it is added back and its tickets reopen them.
  for (const space of data.spaces) {
    if (space.gantry && !space.gantry.completed && !status.projects.some(p => p.id === space.gantry!.projectId)) { space.gantry.completed = true; changed = true; }
  }
  for (const ticket of status.tickets) {
    const project = status.projects.find(p => p.id === ticket.projectId);
    if (!project) continue;
    let space = data.spaces.find(s => s.gantry?.workspace === project.workspace && s.gantry.ticketId === ticket.id);
    if (ticket.status !== "in_progress") {
      if (space?.gantry && !space.gantry.completed) { space.gantry.completed = true; changed = true; }
      continue;
    }
    if (space?.gantry?.completed) { space.gantry.completed = false; changed = true; }
    if (!space) {
      space = newSpace(`${project.name} · ${ticket.title}`, data.spaces);
      space.gantry = { projectId: project.id, workspace: project.workspace, ticketId: ticket.id };
      data.spaces.push(space);
      changed = true;
    }
    const name = `${project.name} · ${ticket.title}`;
    if (space.name !== name) { space.name = name; changed = true; }
    const urls = [
      ...ticket.pullRequests.map(p => p.url),
      ...status.pulls.filter(g => g.projectId === project.id && g.branch === ticket.branch).flatMap(g => Object.values(g.pulls).map(p => p.url)),
    ];
    const targets = urls.flatMap((url) => {
      const parsed = parseGithub(url);
      return parsed?.kind === "pull" ? [`${parsed.owner}/${parsed.repo}/pull/${parsed.number}`] : [];
    });
    // A local output gives way to a PR from the same repo, which shows the same commits.
    const hasPull = (github: string | null) => !!github && [...targets, ...space.targets].some((t) => t.toLowerCase().startsWith(`${github}/pull/`));
    for (const local of outputs[ticket.id]?.targets ?? []) {
      if (hasPull(local.github) && space.targets.includes(local.id)) {
        space.targets = space.targets.filter((t) => t !== local.id);
        if (space.active === local.id) space.active = space.targets[0] ?? null;
        changed = true;
      }
    }
    const locals = (outputs[ticket.id]?.targets ?? []).filter((l) => !hasPull(l.github)).map((l) => l.id);
    for (const target of [...targets, ...locals]) {
      if (!space.targets.includes(target)) {
        space.targets.push(target);
        space.active ??= target;
        space.updatedAt = Date.now();
        changed = true;
      }
    }
    const links = outputs[ticket.id]?.links ?? [];
    if (JSON.stringify(space.links ?? []) !== JSON.stringify(links)) { space.links = links; changed = true; }
    result[ticket.id] = space.id;
  }
  if (!data.spaces.some(s => !s.gantry?.completed)) {
    data.spaces.push(newSpace("My reviews", data.spaces)); changed = true;
  }
  if (!data.spaces.some(s => s.id === data.current && !s.gantry?.completed)) {
    data.current = data.spaces.find(s => !s.gantry?.completed)!.id; changed = true;
  }
  if (changed) write(data);
  return result;
}
