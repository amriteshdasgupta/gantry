import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const runtimeUrl = `http://127.0.0.1:${process.env.GANTRY_E2E_RUNTIME_PORT ?? 3458}`;

test('Gantry serves its selected logo and browser icons locally', async ({ page }) => {
  await page.goto('/');
  const logo = page.locator('.app-bar img[src="/gantry-icon.svg"]');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('alt', '');
  expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);

  const svg = await page.request.get('/gantry-icon.svg');
  expect(svg.ok()).toBe(true);
  expect(await svg.text()).toContain('#6D28D9');

  const icons = await page.locator('link[rel="icon"]').evaluateAll(links =>
    links.map(link => (link as HTMLLinkElement).href),
  );
  expect(icons.some(url => new URL(url).pathname === '/favicon.ico')).toBe(true);
  expect(icons.some(url => new URL(url).pathname === '/icon.svg')).toBe(true);

  for (const url of icons) {
    expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    const response = await page.request.get(url);
    expect(response.ok()).toBe(true);
    expect((await response.body()).length).toBeGreaterThan(0);
  }
});

test('Gantry ticket, preview and review workflow stays inside Gantry', async ({ page }) => {
  const initialSpaces = await (await page.request.get('/api/spaces')).json();
  await page.goto('/');
  await expect(page.getByRole('navigation',{name:'Workspaces'}).getByRole('button',{name:/^Fixture workspace/})).toBeVisible();
  await page.getByRole('button', {name:'New ticket',exact:true}).click();
  await page.getByLabel('Title', {exact:true}).fill('Draft ticket');
  await page.getByLabel('Notes', {exact:true}).fill('Keep the review in this app.');
  await page.getByRole('button',{name:'Create ticket',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('article').filter({ hasText: 'Draft ticket' }).getByRole('button').first().click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Draft ticket',exact:true}).first()).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Edit',exact:true}).click();
  await page.getByLabel('Title',{exact:true}).fill('Test the unified workspace');
  await page.getByLabel('Notes',{exact:true}).fill('Updated ticket details persist after reload.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('heading',{name:'Test the unified workspace',exact:true}).first()).toBeVisible();
  await page.reload();
  await page.locator('article').filter({hasText:'Test the unified workspace'}).getByRole('button').first().click();
  await expect(page.getByText('Updated ticket details persist after reload.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Open chat',exact:true})).toHaveCount(0);
  await page.getByRole('combobox',{name:'Stage',exact:true}).selectOption('in_progress');
  await expect(page.getByRole('button',{name:'Open chat',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Create worktrees',exact:true}).click();
  await expect(page.getByText('Ticket worktrees are ready',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await expect(page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Previews/})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview Test the unified workspace',exact:true}).click();
  await page.getByRole('button',{name:'Logs',exact:true}).click();
  await expect(page.getByText('Fixture preview ready', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await page.getByRole('button',{name:'Open review space for Test the unified workspace',exact:true}).click();
  await expect(page).toHaveURL(/review=/);
  await expect(page.getByRole('tab',{name:'fixture #1',exact:true})).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('electron'));
  const switcher = page.getByRole('button', { name: 'Switch space', exact: true });
  const reviewHeader = page.locator('header').filter({ has: switcher });
  await expect(reviewHeader).toHaveCSS('padding-left', '12px');
  await expect(switcher).toHaveCSS('width', '288px');
  await switcher.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await page.evaluate(() => document.documentElement.classList.remove('electron'));
  await expect(page.getByRole('banner').getByText('PR Lens',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Gantry',exact:true})).toHaveCount(0);
  await expect(page.getByText('Guard add against NaN').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({path:'e2e/.tmp/ticket-review-back.png'});
  await expect(page.getByRole('button',{name:'Back',exact:true})).toHaveCount(0);
  await page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Tickets/}).click();
  await expect(page).toHaveURL(/workspace=fixture$/);
  await expect(page.getByRole('region',{name:'Ticket board'})).toBeVisible();
  await page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Reviews/}).click();
  await expect(page.getByRole('tab',{name:'fixture #1',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab',{name:'fixture #1',exact:true})).toBeVisible();
  await page.request.patch('/api/spaces',{data:{id:initialSpaces.current,makeCurrent:true}});
  fs.rmSync(path.resolve('e2e/.tmp', 'home', 'ticket-conversations/ticket-1.json'),{force:true});
});

test('workspace hierarchy keeps reviews, previews and deep links in their owning context', async ({ page, request }) => {
  const base = await (await request.get(`${runtimeUrl}/api/status`)).json();
  const originalSpaces = await (await request.get('/api/spaces')).json();
  const makeTicket = (id: string, projectId: string, title: string) => ({
    id, projectId, title, description: '', status: 'in_progress', branch: `ticket/${id}`,
    pullRequests: [], artifacts: [], run: null,
  });
  const status = {
    ...base,
    projects: [base.projects[0], { ...base.projects[0], id: 'other', name: 'Other workspace', workspace: '/fixture/other' }],
    tickets: [makeTicket('context-one', 'fixture', 'First workspace work'), makeTicket('context-two', 'other', 'Second workspace work')],
    previews: [],
    pulls: [],
  };
  const workspaces = page.getByRole('navigation', { name: 'Workspaces', exact: true });
  const context = page.getByLabel('Current workspace', { exact: true });

  try {
    await request.post(`${runtimeUrl}/__fixture`, { data: { status } });
    await page.goto('/?workspace=fixture');
    await expect(context).toHaveText('Fixture workspace/Tickets');
    await expect(workspaces.locator('[aria-current="true"]')).toContainText('Fixture workspace');
    const firstNavigation = page.getByRole('region', { name: 'Fixture workspace navigation', exact: true });
    await expect(firstNavigation).toContainText('/fixture/workspace');
    await expect(firstNavigation.getByRole('navigation', { name: 'Previews', exact: true })).toContainText('First workspace work');
    await expect(firstNavigation).not.toContainText('Second workspace work');

    await page.getByRole('button', { name: 'Open review space for First workspace work', exact: true }).click();
    await expect(context).toHaveText('Fixture workspace/Reviews');
    const firstUrl = page.url();
    await page.getByRole('button', { name: 'Switch space', exact: true }).click();
    await expect(page.getByRole('menu')).toContainText('First workspace work');
    await expect(page.getByRole('menu')).not.toContainText('Second workspace work');
    await expect(page.getByRole('menuitem', { name: 'New space', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await workspaces.getByRole('button', { name: /^Other workspace/ }).click();
    await expect(context).toHaveText('Other workspace/Tickets');
    await expect(page).not.toHaveURL(/review=/);
    await expect(page.getByRole('region', { name: 'Ticket board' })).toContainText('Second workspace work');
    await expect(page.getByRole('region', { name: 'Ticket board' })).not.toContainText('First workspace work');
    const previews = page.getByRole('navigation', { name: 'Previews', exact: true });
    await previews.getByRole('button', { name: 'Second workspace work', exact: true }).click();
    await expect(context).toHaveText('Other workspace/Previews');
    await expect(previews.getByRole('button', { name: 'Second workspace work', exact: true })).toHaveAttribute('aria-current', 'page');

    // The review association overrides a stale workspace parameter and saved choice.
    const deepLink = new URL(firstUrl);
    deepLink.searchParams.set('workspace', 'other');
    await page.goto(deepLink.toString());
    await expect(context).toHaveText('Fixture workspace/Reviews');
    await expect(page).toHaveURL(/workspace=fixture/);
    await expect(workspaces.locator('[aria-current="true"]')).toContainText('Fixture workspace');
    await page.getByRole('navigation', { name: 'Gantry workspace', exact: true }).getByRole('button', { name: /Tickets/ }).click();
    await expect(context).toHaveText('Fixture workspace/Tickets');

    await workspaces.getByRole('button', { name: /^Other workspace/ }).click();
    await expect(previews.getByRole('button', { name: 'Second workspace work', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await previews.getByRole('button', { name: 'Main', exact: true }).click();
    await expect(previews.getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(context).toHaveText('Other workspace/Tickets');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(context).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await request.post(`${runtimeUrl}/__fixture`, { data: { status: null } });
    await page.goto('/reviews');
    const current = await (await request.get('/api/spaces')).json();
    for (const space of current.spaces) {
      if (!originalSpaces.spaces.some((s: { id: string }) => s.id === space.id)) {
        await request.delete(`/api/spaces?id=${space.id}`);
      }
    }
    await request.patch('/api/spaces', { data: { id: originalSpaces.current, makeCurrent: true } });
  }
});

test('Gantry proxy rejects cross-origin mutations and unsupported routes', async ({ request }) => {
  const crossOrigin = await request.post('/api/gantry/api/projects', {headers:{Origin:'https://untrusted.example'},data:{workspace:'/tmp'}});
  expect(crossOrigin.status()).toBe(403);
  expect((await request.get('/api/gantry/api/private')).status()).toBe(404);
  expect((await request.get('/api/gantry/api/version')).status()).toBe(200);
});

test('Gantry shows a recoverable connection error', async ({ page }) => {
  await page.route('**/api/gantry/api/status', route => route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Gantry is unavailable. Reopen the desktop app, or start Gantry and retry.'})}));
  await page.goto('/');
  await expect(page.getByRole('alert').filter({hasText:'Gantry is unavailable'})).toContainText('Gantry is unavailable');
  await expect(page.getByRole('button',{name:'Refresh Gantry'})).toBeEnabled();
});

test('Gantry follows the review app themes and desktop window sizes', async ({ page }) => {
  await page.goto('/reviews');
  await expect(page.getByPlaceholder(/github.com/)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // Let shared control and theme transitions settle for visual review.
  await page.screenshot({path:'e2e/.tmp/incumbent-home.png'});
  await page.goto('/');
  await expect(page.getByRole('navigation',{name:'Workspaces'}).getByRole('button',{name:/^Fixture workspace/})).toBeVisible();
  await page.getByRole('button',{name:'New ticket',exact:true}).click();
  await page.getByLabel('Title', {exact:true}).fill('Keep branch previews stable across restarts');
  await page.getByLabel('Notes', {exact:true}).fill('Reuse managed services when their configuration is unchanged. Verify that the agent can prepare the branch, open a preview, and hand it over for review.');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // Let shared control and theme transitions settle for visual review.
  await page.screenshot({path:'e2e/.tmp/unified-tickets-light.png'});
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await page.getByRole('button',{name:'Toggle theme'}).click();
  await page.getByRole('button',{name:'Edit ticket Test the unified workspace',exact:true}).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.setViewportSize({width:900,height:650});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // Let shared control and theme transitions settle for visual review.
  await page.screenshot({path:'e2e/.tmp/unified-tickets-dark-compact.png'});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Previews/})).toHaveCount(0);
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await page.getByRole('button',{name:'Preview Test the unified workspace',exact:true}).click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // Let shared control and theme transitions settle for visual review.
  await page.screenshot({path:'e2e/.tmp/unified-previews-dark-compact.png'});
  await page.getByRole('button',{name:'Close details',exact:true}).click();
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Reviews/}).click();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250); // Let shared control and theme transitions settle for visual review.
  await page.screenshot({path:'e2e/.tmp/unified-reviews-dark.png'});
});

test('workspace tickets own stable spaces and collect all associated PRs', async ({page,request}) => {
  test.setTimeout(90000);
  const base = await (await request.get(`${runtimeUrl}/api/status`)).json();
  const originalSpaces = await (await request.get('/api/spaces')).json();
  const ticket = (id:string,projectId:string,branch:string) => ({id,projectId,title:'Shared title',description:'',status:'in_progress',scope:'both',branch,pullRequests:[],artifacts:[],run:null});
  const status = {...base,projects:[base.projects[0],{...base.projects[0],id:'other',name:'Other workspace',workspace:'/fixture/other'}],
    tickets:[ticket('linked-one','fixture','ticket/review'),ticket('linked-two','other','ticket/review'),ticket('empty-ticket','fixture','feature/empty')],
    pulls:[{...base.pulls[0],pulls:{frontend:base.pulls[0].pulls.frontend,backend:{number:2,url:'https://github.com/local/fixture/pull/2',title:'Backend fix'}}}],
  };
  try {
    await request.post(`${runtimeUrl}/__fixture`,{data:{status}});
    await page.goto('/');
    await expect(page.getByRole('region',{name:'Ticket board'})).toBeVisible();
    const first = await (await request.get('/api/gantry/api/status')).json();
    const spaces = await (await request.get('/api/spaces')).json();
    const one = spaces.spaces.find((s:{id:string})=>s.id===first.tickets[0].reviewSpaceId);
    const two = spaces.spaces.find((s:{id:string})=>s.id===first.tickets[1].reviewSpaceId);
    expect(one.id).not.toBe(two.id);
    expect(one.targets).toEqual(['local/fixture/pull/1','local/fixture/pull/2']);
    expect(two.targets).toEqual([]);
    expect(first.tickets[2].reviewSpaceId).toBeTruthy();
    await request.patch('/api/spaces',{data:{id:one.id,active:'local/fixture/pull/1',file:{target:'local/fixture/pull/1',path:'src/math.ts'}}});
    await page.getByRole('button',{name:'Open review space for Shared title',exact:true}).first().click();
    await expect(page).toHaveURL(new RegExp(`review=${one.id}`));
    await expect(page.getByRole('tab',{name:'fixture #1',exact:true})).toBeVisible();
    await expect(page.getByRole('tab',{name:'fixture #2',exact:true})).toBeVisible();
    // A new PR arrives while the user remains in the space.
    status.tickets[0].pullRequests = [{role:'docs',number:3,url:'https://github.com/local/fixture/pull/3',title:'Docs fix'}] as never[];
    await request.post(`${runtimeUrl}/__fixture`,{data:{status}});
    await expect(page.getByRole('tab',{name:'fixture #3',exact:true})).toBeVisible({timeout:15000});
    const repeated = await (await request.get('/api/gantry/api/status')).json();
    expect(repeated.tickets[0].reviewSpaceId).toBe(one.id);
    const updated = (await (await request.get('/api/spaces')).json()).spaces.find((s:{id:string})=>s.id===one.id);
    expect(updated.targets).toHaveLength(3);
    expect(updated.files['local/fixture/pull/1']).toBe('src/math.ts');
    status.tickets[0].status = 'done';
    await request.post(`${runtimeUrl}/__fixture`,{data:{status}});
    const completed = await (await request.get('/api/gantry/api/status')).json();
    expect(completed.tickets[0].reviewSpaceId).toBeUndefined();
    expect((await (await request.get('/api/spaces')).json()).spaces.some((s:{id:string}) => s.id === one.id)).toBe(false);
    expect((await request.patch('/api/spaces',{data:{id:one.id,makeCurrent:true}})).status()).toBe(404);
    await expect(page).not.toHaveURL(/review=/, {timeout:15000});
    await expect(page.getByRole('region',{name:'Done',exact:true}).getByRole('button',{name:/Open review space/})).toHaveCount(0);
    await expect(page.getByRole('region',{name:'Done',exact:true}).getByRole('button',{name:/Preview/})).toHaveCount(0);
    status.tickets[0].status = 'in_progress';
    await request.post(`${runtimeUrl}/__fixture`,{data:{status}});
    const reopened = await (await request.get('/api/gantry/api/status')).json();
    expect(reopened.tickets[0].reviewSpaceId).toBe(one.id);
    await page.goto(`/space/${one.id}`);
    await page.getByRole('button',{name:'Back',exact:true}).click();
    await expect(page.getByRole('navigation',{name:'Workspaces'}).locator('[aria-current="true"]')).toContainText('Fixture workspace');
    await expect(page.getByRole('region',{name:'Ticket details'})).toBeVisible();
    await page.getByRole('button',{name:'Close details',exact:true}).click();
    await page.getByRole('navigation',{name:'Workspaces'}).getByRole('button', { name: /^Other workspace/ }).click();
    await page.getByRole('button',{name:'Open review space for Shared title',exact:true}).click();
    await expect(page).toHaveURL(new RegExp(`review=${two.id}`));
    await expect(page.getByRole('tab')).toHaveCount(0);
  } finally {
    await request.post(`${runtimeUrl}/__fixture`,{data:{status:null}});
    await page.goto('/reviews');
    const current = await (await request.get('/api/spaces')).json();
    for (const space of current.spaces) {
      if (!originalSpaces.spaces.some((s:{id:string}) => s.id === space.id)) await request.delete(`/api/spaces?id=${space.id}`);
    }
    await request.patch('/api/spaces',{data:{id:originalSpaces.current,makeCurrent:true}});
  }
});


test('tickets drag between columns and reopen one external Codex conversation', async ({page,request}) => {
  await page.goto('/');
  const card = page.locator('article').filter({hasText:'Test the unified workspace'});
  await card.dragTo(page.getByRole('region',{name:'Backlog',exact:true}));
  await expect(page.getByRole('region',{name:'Backlog',exact:true}).locator('article')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('region',{name:'Backlog',exact:true}).locator('article')).toHaveCount(1);
  const agents = await (await request.get('/api/agents')).json();
  const codex = agents.agents.find((a:{kind:string}) => a.kind === 'codex') || await (await request.post('/api/agents',{data:{kind:'codex',name:'Codex'}})).json();
  await request.patch('/api/agents',{data:{id:codex.id,current:true}});
  await page.reload();
  const launches = path.resolve('e2e/.tmp', 'home', 'external-launches.jsonl');
  await page.getByRole('button',{name:'Workspace graph',exact:true}).click();
  await page.getByRole('button',{name:'Edit shared instructions',exact:true}).click();
  await page.getByLabel('Starting prompt',{exact:true}).fill('Workspace delivery rule: implement ${ticket.title}, validate, then create a PR.');
  await page.getByRole('button',{name:'Save prompt',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button',{name:'Workspace graph',exact:true}).click();
  await page.getByRole('button',{name:'Edit shared instructions',exact:true}).click();
  await expect(page.getByLabel('Starting prompt',{exact:true})).toHaveValue('Workspace delivery rule: implement ${ticket.title}, validate, then create a PR.');
  await page.screenshot({path:'e2e/.tmp/workspace-prompt.png'});
  await page.getByRole('dialog').last().getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/^Tickets/}).click();
  await expect(page.getByRole('button',{name:'Open chat for Test the unified workspace'})).toHaveCount(0);
  await card.dragTo(page.getByRole('region',{name:'In progress',exact:true}));
  // Moving a ticket only changes its status; the chat opens from the card.
  await page.getByRole('button',{name:'Open chat for Test the unified workspace'}).click();
  await expect(page.getByText("Opened this ticket's Codex chat in herdr",{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const initial = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'load'}})).json();
  expect(initial.conversation.provider).toBe('codex');
  const id = initial.conversation.sessionId;
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  // Every chat opens in herdr: the pane runs `codex resume` with the opening message; the context is already in the thread.
  const herdrRuns = () => fs.readFileSync(launches,'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(c=>c.command==='herdr' && c.args[0]==='pane' && c.args[1]==='run');
  expect(herdrRuns()).toHaveLength(1);
  expect(herdrRuns()[0].script).toContain(`'resume' '${id}'`);
  expect(herdrRuns()[0].script).toContain('Start the work described above.');
  const protocol = fs.readFileSync(path.resolve('e2e/.tmp', 'home', 'codex-protocol.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  expect(protocol.filter(c=>c.method==='thread/start')).toHaveLength(1);
  expect(protocol.some(c=>c.method==='turn/start')).toBe(false);
  expect(protocol.some(c=>c.method==='thread/inject_items')).toBe(true);
  expect(fs.existsSync(path.resolve('e2e/.tmp/home', id+'.jsonl'))).toBe(true);
  expect(protocol.find(c=>c.method==='thread/start').params.developerInstructions).toContain('Workspace delivery rule: implement Test the unified workspace, validate, then create a PR.');
  await request.post('/api/gantry/api/projects/fixture/chat-prompt',{data:{prompt:'Changed for future conversations'}});
  await request.patch('/api/agents',{data:{id:'claude',current:true}});
  const responses = await Promise.all([1,2].map(()=>request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})));
  for (const response of responses) expect((await response.json()).conversation.sessionId).toBe(id);
  expect(herdrRuns().at(-1)!.script).toContain(id);
  expect(herdrRuns().at(-1)!.script).not.toContain('Start the work described above.');
  await page.reload();
  await page.getByRole('button',{name:'Edit ticket Test the unified workspace'}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Chat',exact:true})).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:/Ask/})).toHaveCount(0);
  await expect(page.getByText(/Linked to Codex/)).toBeVisible();
  await page.setViewportSize({width:900,height:650});
  await page.screenshot({path:'e2e/.tmp/external-conversation-compact.png'});
  await page.keyboard.press('Escape');
  expect((await request.post('/api/ticket-chat',{headers:{Origin:'https://other.example'},data:{ticketId:'ticket-1',action:'open'}})).status()).toBe(403);
  expect((await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'send',text:'Do not run'}})).status()).toBe(400);
  fs.unlinkSync(path.resolve('e2e/.tmp/home', id+'.jsonl'));
  fs.writeFileSync(path.resolve('e2e/.tmp', 'home', 'fail-external-launch'),'fixture');
  const runsBefore = herdrRuns().length;
  expect((await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).ok()).toBe(false);
  expect(herdrRuns()).toHaveLength(runsBefore);
  fs.unlinkSync(path.resolve('e2e/.tmp', 'home', 'fail-external-launch'));
  const recovered = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).json();
  expect(recovered.conversation.sessionId).not.toBe(id);
  // The failed launch never reached the chat, so the recovered thread still gets its opening message.
  expect(herdrRuns().at(-1)!.script).toContain(`'resume' '${recovered.conversation.sessionId}'`);
  expect(herdrRuns().at(-1)!.script).toContain('Start the work described above.');
  expect(fs.existsSync(path.resolve('e2e/.tmp/home', recovered.conversation.sessionId+'.jsonl'))).toBe(true);
  const again = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).json();
  expect(again.conversation.sessionId).toBe(recovered.conversation.sessionId);
  expect(herdrRuns().at(-1)!.script).not.toContain('Start the work described above.');
  await request.patch('/api/agents',{data:{id:agents.current,current:true}});
});

test('Claude conversation uses one session ID and resumes it; launch failures retain association', async ({request}) => {
  const home = path.resolve('e2e/.tmp/home');
  const recordFile = path.join(home,'ticket-conversations/ticket-1.json');
  fs.unlinkSync(recordFile); // Reset only this disposable fixture's association.
  await request.patch('/api/agents',{data:{id:'claude',current:true}});
  fs.writeFileSync(path.join(home,'fail-external-launch'),'fixture');
  expect((await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).ok()).toBe(false);
  const failed = JSON.parse(fs.readFileSync(recordFile,'utf8'));
  fs.unlinkSync(path.join(home,'fail-external-launch'));
  const first = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).json();
  expect(first.conversation.sessionId).toBe(failed.sessionId);
  expect(first.conversation.provider).toBe('claude');
  const sessionDir=path.resolve('e2e/.tmp/claude-config/projects/fixture');
  fs.mkdirSync(sessionDir,{recursive:true});
  fs.writeFileSync(path.join(sessionDir,failed.sessionId+'.jsonl'),'{}');
  const reopened = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).json();
  expect(reopened.conversation.sessionId).toBe(failed.sessionId);
  const runs=fs.readFileSync(path.join(home,'external-launches.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(c=>c.command==='herdr' && c.args[1]==='run');
  expect(runs.at(-1).script).toContain('--resume');
  expect(runs.at(-1).script).toContain('Changed for future conversations');
  expect(runs.at(-1).script).toContain(failed.sessionId);
});

test('OpenCode conversation is created with the ticket context and opens in herdr', async ({request}) => {
  const home = path.resolve('e2e/.tmp/home');
  const recordFile = path.join(home,'ticket-conversations/ticket-1.json');
  fs.unlinkSync(recordFile); // Reset only this disposable fixture's association.
  const previous = await (await request.get('/api/agents')).json();
  const provider = await (await request.post('/api/agents',{data:{kind:'opencode',name:'OpenCode'}})).json();
  const opened = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).json();
  expect(opened.conversation.provider).toBe('opencode');
  const id = opened.conversation.sessionId;
  expect(id).toMatch(/^ses_\w+$/);
  // The session was made without a model turn: the context went in with noReply, behind the server's password.
  const protocol = fs.readFileSync(path.join(home,'opencode-protocol.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l));
  const context = protocol.find(c=>c.path===`/session/${id}/message`);
  expect(protocol.every(c=>c.authorized)).toBe(true);
  expect(context.body.noReply).toBe(true);
  expect(context.body.parts[0].text).toContain('Changed for future conversations');
  const calls = () => fs.readFileSync(path.join(home,'external-launches.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(c=>c.command==='herdr');
  expect(calls().filter(c=>c.args[1]==='run').at(-1).script).toContain(`'opencode' '-s' '${id}'`);
  // OpenCode takes no opening message on resume, so herdr types it into the chat.
  expect(calls().some(c=>c.args[1]==='send-text' && c.args.at(-1)==='Start the work described above.')).toBe(true);
  const sent = calls().filter(c=>c.args[1]==='send-text').length;
  const again = await (await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}})).json();
  expect(again.conversation.sessionId).toBe(id);
  expect(calls().filter(c=>c.args[1]==='send-text')).toHaveLength(sent);
  await request.patch('/api/agents',{data:{id:previous.current,current:true}});
  await request.delete(`/api/agents?id=${provider.id}`);
});

test('API-only providers fail clearly without launching or creating an embedded chat', async ({request}) => {
  const home=path.resolve('e2e/.tmp/home');
  fs.unlinkSync(path.join(home,'ticket-conversations/ticket-1.json'));
  const previous = await (await request.get('/api/agents')).json();
  const provider = await (await request.post('/api/agents',{data:{kind:'openai',name:'API fixture',baseUrl:'http://127.0.0.1:9',model:'fixture'}})).json();
  const response=await request.post('/api/ticket-chat',{data:{ticketId:'ticket-1',action:'open'}});
  expect(response.status()).toBe(409);
  expect((await response.json()).error).toContain('API endpoint');
  expect(fs.existsSync(path.join(home,'ticket-conversations/ticket-1.json'))).toBe(false);
  await request.patch('/api/agents',{data:{id:previous.current,current:true}});
  await request.delete(`/api/agents?id=${provider.id}`);
});

test('ticket colours are distinct, survive moves and reloads, and stay readable in both themes', async ({page,request}) => {
  const status=await (await request.get(`${runtimeUrl}/api/status`)).json();
  const titles=['Refresh the exam creator','Improve graphs','Make insights clearer','Collaborative exams','Simplify question search','Export answer sheets','Online exam runtime','Preview branch changes','Answer sheet tags','Faster document uploads'];
  const tickets=titles.map((title,i)=>({projectId:'fixture',description:'',scope:'both',run:null,pullRequests:[],artifacts:[],...status.tickets[0],id:`colour-${i}`,title,branch:`ticket/colour-${i}`,status:i<6?'backlog':i<8?'in_progress':'done',position:i}));
  try {
    await request.post(`${runtimeUrl}/__fixture`,{data:{status:{...status,tickets}}});
    await page.goto('/');
    const cards=page.locator('article[data-ticket-id]');
    await expect(cards).toHaveCount(10);
    await expect.poll(()=>cards.evaluateAll(es=>new Set(es.map(e=>e.getAttribute('style'))).size)).toBe(10);
    const original=await cards.evaluateAll(es=>Object.fromEntries(es.map(e=>[e.getAttribute('data-ticket-id'),e.getAttribute('style')])));
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>localStorage.setItem('theme',theme),theme);
      await page.reload();
      await expect(cards).toHaveCount(10);
      await expect.poll(()=>cards.evaluateAll(es=>new Set(es.map(e=>e.getAttribute('style'))).size)).toBe(10);
      await page.setViewportSize({width:1440,height:1000});
      await page.screenshot({path:`e2e/.tmp/colour-board-${theme}.png`});
      const minimum=await cards.evaluateAll(es=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d')!;
        const lum=(color:string)=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const rgb=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
        return Math.min(...es.flatMap(e=>{const bg=lum(getComputedStyle(e).backgroundColor);return [e,e.querySelector('.text-muted-foreground')!,...e.querySelectorAll('.gantry-ticket-actions button:not(:disabled)')].map(el=>{const fg=lum(getComputedStyle(el).color);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);});}));
      });
      expect(minimum).toBeGreaterThanOrEqual(4.5);
    }
    tickets[0].status='in_progress'; tickets.reverse();
    await request.post(`${runtimeUrl}/__fixture`,{data:{status:{...status,tickets}}});
    await page.reload();
    await expect(cards).toHaveCount(10);
    await expect.poll(()=>cards.evaluateAll(es=>Object.fromEntries(es.map(e=>[e.getAttribute('data-ticket-id'),e.getAttribute('style')])))).toEqual(original);
    await page.setViewportSize({width:900,height:650});
    await page.screenshot({path:'e2e/.tmp/colour-board-compact.png'});
    await page.getByRole('button',{name:/Refresh the exam creator.*ticket\/colour-0/}).click();
    await expect(page.getByRole('dialog').locator('header')).toHaveClass(/gantry-ticket-heading/);
  } finally { await request.post(`${runtimeUrl}/__fixture`,{data:{status:null}}); }
});

test('tickets can be deleted from the board after confirmation, including Done tickets', async ({page,request}) => {
  const original=(await (await request.get(`${runtimeUrl}/api/status`)).json()).tickets[0];
  await request.post(`${runtimeUrl}/api/projects/fixture/tickets`,{data:{title:'Disposable deletion ticket',branch:'ticket/delete',description:''}});
  await page.goto('/');
  const card=page.locator('article[data-ticket-id="ticket-1"]');
  const remove=card.getByRole('button',{name:'Delete ticket Disposable deletion ticket',exact:true});
  await remove.click();
  const dialog=page.getByRole('dialog',{name:'Delete ticket?'});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('This removes the ticket from your board. Its worktrees and pull requests will remain.')).toBeVisible();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(remove).toBeFocused();
  await expect(card).toBeVisible();
  await request.post(`${runtimeUrl}/api/tickets/ticket-1/update`,{data:{run:{agent:'generic',state:'running'}}});
  await page.reload();
  await expect(remove).toBeDisabled();
  await request.post(`${runtimeUrl}/api/tickets/ticket-1/update`,{data:{status:'done',run:null}});
  await page.reload();
  await remove.click();
  await page.setViewportSize({width:900,height:650});
  await page.screenshot({path:'e2e/.tmp/delete-ticket-dialog.png'});
  await dialog.getByRole('button',{name:'Delete ticket',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(card).toHaveCount(0);
  // Restore shared fixture state for subsequent review-space tests.
  await request.post(`${runtimeUrl}/api/projects/fixture/tickets`,{data:original});
  await request.post(`${runtimeUrl}/api/tickets/ticket-1/update`,{data:original});
  await request.get('/api/gantry/api/status');
});

test('sidebar embeds Main and in-progress ticket previews, excluding backlog and Done', async ({page,request}) => {
  const original=await (await request.get(`${runtimeUrl}/api/status`)).json();
  const ticket={...original.tickets[0],projectId:'fixture',run:null,description:'',scope:'both',pullRequests:[],artifacts:[]};
  const preview={...original.previews[0],status:'Running',checkouts:[],isPrimary:false};
  const status={...original,tickets:[{...ticket,id:'active-preview',title:'codex/online-exam-runtime-implementation',branch:'ticket/runtime',status:'in_progress'},{...ticket,id:'done-preview',title:'Finished work',branch:'ticket/done',status:'done'},{...ticket,id:'backlog-preview',title:'Future work',branch:'ticket/future',status:'backlog'}],previews:[{...preview,id:'main-preview',branch:'__primary__',isPrimary:true},{...preview,id:'active-preview',branch:'ticket/runtime'}]};
  await page.route('http://127.0.0.1:6500/**',route=>route.fulfill({contentType:'text/html',body:'<h1>Embedded application</h1><label>Draft<input></label><a href="/next">Next page</a>'}));
  try {
    await request.post(`${runtimeUrl}/__fixture`,{data:{status}});
    await page.goto('/');
    const nav=page.getByRole('navigation',{name:'Previews',exact:true});
    await expect(nav.getByRole('button')).toHaveCount(2);
    await expect(page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Tickets/})).toHaveText('Tickets1');
    await nav.getByRole('button',{name:'Main',exact:true}).click();
    const frame=page.frameLocator('iframe[title="Main preview"]');
    await expect(frame.getByRole('heading',{name:'Embedded application'})).toBeVisible();
    await frame.getByLabel('Draft').fill('keep my work');
    await page.waitForTimeout(10500);
    await expect(frame.getByLabel('Draft')).toHaveValue('keep my work');
    await frame.getByRole('link',{name:'Next page'}).click();
    await expect(frame.getByRole('heading')).toBeVisible();
    await nav.getByRole('button',{name:'online exam runtime implementation',exact:true}).click();
    await expect(page.frameLocator('iframe[title="online exam runtime implementation preview"]').getByRole('heading')).toBeVisible();
    const activeFrame = page.frameLocator('iframe[title="online exam runtime implementation preview"]');
    await activeFrame.getByLabel('Draft').fill('keep ticket draft');
    await expect(page.getByRole('button', {name:'Open chat',exact:true})).toBeVisible();
    await expect(page.getByRole('button', {name:'Review',exact:true})).toBeVisible();
    await page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Tickets/}).click();
    await nav.getByRole('button',{name:'online exam runtime implementation',exact:true}).click();
    await expect(activeFrame.getByLabel('Draft')).toHaveValue('keep ticket draft');
    await nav.getByRole('button',{name:'Main',exact:true}).click();
    await expect(frame.getByLabel('Draft')).toHaveValue(''); // The earlier /next navigation loaded a fresh page.
    await frame.getByLabel('Draft').fill('keep main draft');
    await nav.getByRole('button',{name:'online exam runtime implementation',exact:true}).click();
    await expect(activeFrame.getByLabel('Draft')).toHaveValue('keep ticket draft');
    await page.getByRole('button',{name:'Reload',exact:true}).click();
    await expect(activeFrame.getByLabel('Draft')).toHaveValue('');
    await nav.getByRole('button',{name:'Main',exact:true}).click();
    await expect(frame.getByLabel('Draft')).toHaveValue('keep main draft');
    await nav.getByRole('button',{name:'online exam runtime implementation',exact:true}).click();
    await page.setViewportSize({width:900,height:650});
    await page.screenshot({path:'e2e/.tmp/sidebar-preview-compact.png'});
    await page.getByRole('button',{name:'Toggle theme'}).click();
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:'e2e/.tmp/sidebar-preview-dark.png'});
    status.tickets[0].status='done';
    await request.post(`${runtimeUrl}/__fixture`,{data:{status}});
    await page.waitForTimeout(10500);
    await expect(nav.getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('navigation',{name:'Gantry workspace'}).getByRole('button',{name:/Tickets/})).toHaveText('Tickets0');
    await expect(page.frameLocator('iframe[title="Main preview"]').getByRole('heading')).toBeVisible();
  } finally {await request.post(`${runtimeUrl}/__fixture`,{data:{status:null}});}
});

test('preview developer tools capture console, errors, fetch and XHR without reloading the page', async ({page,request}) => {
  const original=await (await request.get(`${runtimeUrl}/api/status`)).json();
  const preview={...original.previews[0],id:'main-diagnostics',isPrimary:true,status:'Running',branch:'__primary__',checkouts:[]};
  preview.services=[...preview.services,{id:'backend',state:'ready',port:6501,openLink:'http://127.0.0.1:6501',logUrl:'/logs/preview/main-diagnostics/backend'}];
  await page.route('**/api/gantry/logs/preview/**', route => route.fulfill({contentType:'text/plain',body:route.request().url().endsWith('/backend') ? 'Backend service log' : 'Frontend service log'}));
  const instrumentation=fs.readFileSync(path.resolve('../packages/server/runners/preview-diagnostics.js'),'utf8');
  await page.route('http://127.0.0.1:6500/**',route=> {
    const url=new URL(route.request().url());
    if(url.pathname==='/api/fail') return route.fulfill({status:503,contentType:'application/json',body:'{"ok":false}'});
    if(url.pathname==='/api/large') { expect(route.request().postData()).toBe('request clone body'); return route.fulfill({contentType:'text/plain',body:'x'.repeat(20000)}); }
    if(url.pathname==='/api/ok') return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
    return route.fulfill({contentType:'text/html',body:`<script>${instrumentation}</script><h1>Diagnostic fixture</h1><label>Draft<input></label><button id="run">Run requests</button><script>
      console.log('Startup message');
      document.querySelector('#run').onclick=()=>{
        console.warn('Example warning');
        console.log('Structured value',{count:1});
        fetch('/api/fail',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Test':'fetch-header'},body:JSON.stringify({question:'fetch payload'})}).then(r=>r.json()).then(body=>console.log('Response body intact',body.ok));
        const xhr=new XMLHttpRequest();xhr.open('POST','/api/ok');xhr.setRequestHeader('Content-Type','application/json');xhr.setRequestHeader('X-Debug-Test','xhr-header');xhr.send(JSON.stringify({question:'xhr payload'}));
        Promise.reject(new Error('Example rejected promise'));
        throw new Error('Example uncaught error');
      };
    </script>`});
  });
  try {
    await request.post(`${runtimeUrl}/__fixture`,{data:{status:{...original,previews:[preview]}}});
    await page.goto('/');
    await page.getByRole('navigation',{name:'Previews',exact:true}).getByRole('button',{name:'Main',exact:true}).click();
    const frame=page.frameLocator('iframe[title="Main preview"]');
    await frame.getByLabel('Draft').fill('keep this draft');
    await expect(page.getByRole('button',{name:'Reload',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Refresh Gantry'})).toHaveCount(0);
    await expect(page.getByRole('heading',{name:'Main',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Debug',exact:true}).click();
    const panel=page.getByRole('complementary',{name:'Preview developer tools'});
    await expect(panel.getByText('Startup message',{exact:true}).first()).toBeVisible();
    await frame.getByRole('button',{name:'Run requests'}).click();
    await expect(panel.getByText('Example warning',{exact:true}).first()).toBeVisible();
    await expect(panel.locator('summary').filter({hasText:'Example uncaught error'})).toBeVisible();
    await expect(panel.locator('summary').filter({hasText:'Example rejected promise'})).toBeVisible();
    await expect(panel.locator('summary').filter({hasText:'Response body intact false'})).toBeVisible();
    await panel.getByLabel('Filter logs').fill('Structured');
    await expect(panel.locator('summary')).toHaveCount(1);
    await panel.getByLabel('Filter logs').fill('');
    await panel.getByRole('tab',{name:/Network/}).click();
    await expect(panel.locator('summary').filter({hasText:'/api/fail'})).toContainText('503');
    await expect(panel.locator('summary').filter({hasText:'/api/ok'})).toContainText('200');
    const failed=panel.locator('details').filter({has:page.locator('summary').filter({hasText:'/api/fail'})});
    await expect(failed.locator('summary').getByText('503',{exact:true})).toHaveClass(/text-red/);
    await failed.locator('summary').click();
    await expect(failed.getByRole('tabpanel',{name:'Request details'})).toContainText('fetch payload');
    await expect(failed.getByRole('tabpanel',{name:'Request details'})).toContainText('fetch-header');
    await failed.getByRole('tab',{name:'Response',exact:true}).click();
    await expect(failed.getByRole('tabpanel',{name:'Response details'})).toContainText('"ok": false');
    await failed.locator('summary').click();
    const success=panel.locator('details').filter({has:page.locator('summary').filter({hasText:'/api/ok'})});
    await expect(success.locator('summary').getByText('200',{exact:true})).toHaveClass(/text-emerald/);
    await success.locator('summary').click();
    await expect(success.getByRole('tabpanel',{name:'Request details'})).toContainText('xhr payload');
    await expect(success.getByRole('tabpanel',{name:'Request details'})).toContainText('xhr-header');
    await success.getByRole('tab',{name:'Response',exact:true}).click();
    await expect(success.getByRole('tabpanel',{name:'Response details'})).toContainText('"ok": true');
    await page.screenshot({path:'e2e/.tmp/network-response.png'});
    await success.locator('summary').click();
    await panel.getByLabel('XHR only').check();
    await expect(panel.locator('summary')).toHaveCount(1);
    await expect(panel.locator('summary')).toContainText('/api/ok');
    await panel.getByLabel('XHR only').uncheck();
    await panel.getByLabel('Errors only').check();
    await expect(panel.locator('summary')).toHaveCount(1);
    await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:'e2e/.tmp/preview-network-panel.png'});
    await page.setViewportSize({width:900,height:650});
    await page.screenshot({path:'e2e/.tmp/preview-network-panel-compact.png'});
    const result = await frame.locator('body').evaluate(async () => {
      const response = await fetch(new Request('/api/large',{method:'POST',body:'request clone body'}));
      return (await response.text()).length;
    });
    expect(result).toBe(20000);
    await panel.getByLabel('Errors only').uncheck();
    await panel.getByLabel('Filter logs').fill('/api/large');
    await panel.locator('summary').click();
    await expect(panel.getByRole('tabpanel',{name:'Request details'})).toContainText('request clone body');
    await panel.getByRole('tab',{name:'Response',exact:true}).click();
    await expect(panel.getByRole('tabpanel',{name:'Response details'})).toContainText('[Truncated at 16 KB]');
    await panel.getByLabel('Filter logs').fill('');
    await panel.getByRole('button',{name:'Clear logs'}).click();
    await expect(panel.locator('summary')).toHaveCount(0);
    await panel.getByRole('tab',{name:'Logs',exact:true}).click();
    await expect(panel.getByRole('tabpanel',{name:'Service logs'})).toContainText('Frontend service log');
    await panel.getByLabel('Service',{exact:true}).selectOption('backend');
    await expect(panel.getByRole('tabpanel',{name:'Service logs'})).toContainText('Backend service log');
    await panel.getByRole('button',{name:'Refresh logs'}).click();
    await expect(panel.getByRole('tabpanel',{name:'Service logs'})).toContainText('Backend service log');
    await page.screenshot({path:'e2e/.tmp/preview-debug-logs.png'});
    await panel.getByRole('button',{name:'Close developer tools'}).click();
    await expect(panel).toHaveCount(0);
    await expect(frame.getByLabel('Draft')).toHaveValue('keep this draft');
  } finally {await request.post(`${runtimeUrl}/__fixture`,{data:{status:null}});}
});
