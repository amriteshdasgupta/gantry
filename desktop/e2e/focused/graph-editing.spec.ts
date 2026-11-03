import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, running = false) {
  let graph = { nodes: [{ id: 'plan', label: 'Plan', kind: 'agent', instructions: 'Make a plan', dependsOn: [] }] };
  let prompt = 'Follow the repository instructions.';
  const chatActions: string[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (data: unknown) => route.fulfill({ json: data });
    if (url.pathname === '/api/setup') return json({ ok: true });
    if (url.pathname === '/api/agents') return json({ agents: [], current: null });
    if (url.pathname === '/api/agents/models') return json({ models: [] });
    if (url.pathname === '/api/stage-permissions') return json({ allow: [], common: [] });
    if (url.pathname === '/api/workflow-execution') return json(null);
    if (url.pathname.endsWith('/workflow-templates')) return json([{ id: 'default', name: 'Default', graph }]);
    if (url.pathname.endsWith('/chat-prompt')) {
      if (req.method() === 'POST') prompt = req.postDataJSON().prompt;
      return json({ prompt });
    }
    if (url.pathname.endsWith('/workflow')) {
      if (req.method() === 'POST') graph = req.postDataJSON().graph ?? req.postDataJSON();
      return json(graph);
    }
    if (url.pathname === '/api/ticket-chat') {
      if (req.method() === 'POST') chatActions.push(req.postDataJSON().action);
      return json({ conversation: null });
    }
    if (url.pathname.endsWith('/api/status'))
      return json({
        projects: ['demo', 'other'].map((id) => ({
          id,
          name: id === 'demo' ? 'Demo workspace' : 'Other workspace',
          services: [],
          agents: [],
          environments: [],
        })),
        tickets: [
          {
            id: 'ticket',
            projectId: 'demo',
            title: 'Improve saving',
            branch: 'ticket/saving',
            status: 'in_progress',
            description: '',
            scopes: [],
            pullRequests: [],
            artifacts: [],
            workflow: { graph, revision: 0, states: { plan: { state: 'pending', message: '' } } },
            ...(running ? { execution: { state: 'running', activeNodeId: 'plan', message: 'Planning' } } : {}),
          },
        ],
        pulls: [],
        previews: [],
        jobs: [],
      });
    return json({});
  });
  return chatActions;
}

async function changeNode(page: Page, text: string) {
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await page.getByLabel('Node instructions').fill(text);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
}

function answerLeave(page: Page, accept: boolean) {
  page.once('dialog', async (dialog) => {
    if (dialog.type() !== 'beforeunload') expect(dialog.message()).toContain('unsaved');
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
}

test('workspace drafts warn on navigation, preserve cancelled edits, and clear after saving or discarding', async ({ page }) => {
  await fixture(page);
  await page.goto('/?workspace=demo&view=workflow');
  // Opening an old dependency-based graph must not count as a user edit.
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Edit shared instructions' })).toBeVisible();
  await changeNode(page, 'Keep this draft');
  answerLeave(page, false);
  await page
    .getByRole('navigation', { name: 'Gantry workspace', exact: true })
    .getByRole('button', { name: /Tickets/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Workspace graph', exact: true })).toBeVisible();
  answerLeave(page, false);
  await page.getByRole('button', { name: 'Other workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workspace graph', exact: true })).toBeVisible();
  answerLeave(page, false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).not.toHaveURL(/settings/);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
  await changeNode(page, 'Discard this draft');
  answerLeave(page, true);
  await page
    .getByRole('navigation', { name: 'Gantry workspace', exact: true })
    .getByRole('button', { name: /Tickets/ })
    .click();
  await page.getByRole('button', { name: 'Workspace graph', exact: true }).click();
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await expect(page.getByLabel('Node instructions')).toHaveValue('Keep this draft');
});

test('node and shared instructions warn before closing their own editors', async ({ page }) => {
  await fixture(page);
  await page.goto('/?workspace=demo&view=workflow');
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await page.getByLabel('Node instructions').fill('Unapplied node edits');
  answerLeave(page, false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Edit node', exact: true })).toBeVisible();
  answerLeave(page, true);
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.getByRole('button', { name: 'Edit shared instructions' }).click();
  await expect(page.getByText('Tell every stage how to work in your project.', { exact: false })).toBeVisible();
  await page.getByLabel('Starting prompt', { exact: true }).fill('Use our components and run npm test.');
  answerLeave(page, false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Starting prompt', { exact: true })).toHaveValue('Use our components and run npm test.');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('ticket graph warns on view, tab, and dialog exit; saving leaves without prompting', async ({ page }) => {
  await fixture(page);
  await page.goto('/?workspace=demo&ticket=ticket');
  await page.getByRole('button', { name: 'Edit graph', exact: true }).click();
  await changeNode(page, 'Ticket-specific draft');
  answerLeave(page, false);
  await page.getByRole('button', { name: 'View progress', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workflow canvas editor' })).toBeVisible();
  answerLeave(page, false);
  await page.getByRole('tab', { name: 'Preview', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workflow canvas editor' })).toBeVisible();
  answerLeave(page, false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Improve saving', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit graph', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('running ticket exposes master chat in its header and calls the ticket chat endpoint', async ({ page }) => {
  const actions = await fixture(page, true);
  await page.goto('/?workspace=demo&ticket=ticket');
  const dialog = page.getByRole('dialog', { name: 'Improve saving', exact: true });
  await dialog.locator('header').getByRole('button', { name: 'Open master chat', exact: true }).click();
  await expect.poll(() => actions).toEqual(['open']);
  await expect(dialog.getByRole('button', { name: 'Open chat', exact: true })).toHaveCount(0);
});

test('browser back can be cancelled and failed saves keep the unsaved warning', async ({ page }) => {
  await fixture(page);
  await page.goto('/?workspace=demo');
  await page.goto('/?workspace=demo&view=workflow');
  await changeNode(page, 'Retain after failed save');
  await page.route('**/api/gantry/api/projects/demo/workflow', (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 500, json: { error: 'Could not save this graph' } }) : route.fallback(),
  );
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Workflow canvas editor' }).getByRole('alert')).toContainText('Could not save this graph');
  const cancelled = page.waitForEvent('dialog');
  await page.evaluate(() => history.back());
  const warning = await cancelled;
  expect(['confirm', 'beforeunload']).toContain(warning.type());
  await warning.dismiss();
  await expect(page.getByRole('heading', { name: 'Workspace graph', exact: true })).toBeVisible();
  answerLeave(page, true);
  await page.evaluate(() => history.back());
  await expect(page.getByRole('region', { name: 'Ticket board', exact: true })).toBeVisible();
});

test('assistant creates editable proposals, supports follow-ups and undo, and uses the normal save path', async ({ page }) => {
  await fixture(page);
  const requests: { graph: { nodes: { id: string; instructions: string }[] }; history: unknown[] }[] = [];
  await page.route('**/api/graph-assistant', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const graph = { ...body.graph, nodes: body.graph.nodes.map((node: object) => ({ ...node, instructions: 'Assistant-authored instructions' })) };
    await route.fulfill({ json: { message: 'Improved the Plan instructions.', graph } });
  });
  await page.goto('/?workspace=demo&view=workflow');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await page.getByLabel('Graph request', { exact: true }).fill('Improve the Plan prompt');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByLabel('Workflow canvas', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await page.getByRole('button', { name: 'Undo assistant change', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
  await page.getByLabel('Graph request', { exact: true }).fill('Try again with verification');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  expect(requests[1].history).toHaveLength(2);
  expect(requests[1].graph.nodes[0].instructions).toBe('Make a plan');
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await expect(page.getByLabel('Node instructions')).toHaveValue('Assistant-authored instructions');
  await page.getByLabel('Node instructions').fill('Manually refined instructions');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo assistant change', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save graph', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
});

test('assistant protects concurrent manual edits, reports errors, and cancels requests', async ({ page }) => {
  await fixture(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/graph-assistant', async (route) => {
    const body = route.request().postDataJSON();
    await pending;
    await route.fulfill({ json: { message: 'Proposal ready', graph: body.graph } });
  });
  await page.goto('/?workspace=demo&view=workflow');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await page.getByLabel('Graph request', { exact: true }).fill('Improve this graph');
  const request = page.waitForRequest('**/api/graph-assistant');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await request;
  await changeNode(page, 'Manual change while thinking');
  release();
  await expect(page.getByRole('button', { name: 'Apply proposal', exact: true })).toBeDisabled();
  await expect(page.getByText('The draft changed.', { exact: false })).toBeVisible();
  await page.route('**/api/graph-assistant', (route) => route.fulfill({ status: 502, json: { error: 'Provider unavailable' } }));
  await page.getByLabel('Graph request', { exact: true }).fill('Retry');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Graph assistant' }).getByRole('alert')).toContainText('Provider unavailable');
  await page.route('**/api/graph-assistant', () => new Promise(() => {}));
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send request', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Hide assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Edit node Plan', exact: true }).click();
  await expect(page.getByLabel('Node instructions')).toHaveValue('Manual change while thinking');
});

test('ticket graph exposes the same assistant beside its editable canvas', async ({ page }) => {
  await fixture(page);
  await page.goto('/?workspace=demo&ticket=ticket');
  await page.getByRole('button', { name: 'Edit graph', exact: true }).click();
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Graph assistant' })).toBeVisible();
  await expect(page.getByLabel('Workflow canvas', { exact: true })).toBeVisible();
});

test('graph assistant API validates local origin and graph payloads before invoking providers', async ({ request }) => {
  const crossOrigin = await request.post('/api/graph-assistant', {
    headers: { origin: 'https://example.com' },
    data: {},
  });
  expect(crossOrigin.status()).toBe(403);

  const invalid = await request.post('/api/graph-assistant', { data: { graph: { nodes: [] }, prompt: '' } });
  expect(invalid.status()).toBe(400);

  const malformed = await request.post('/api/graph-assistant', { data: '{' });
  expect(malformed.status()).toBe(400);
});

test('assistant builds a new ticket graph from an empty template and saves its prompts and routes', async ({ page }) => {
  await fixture(page);
  await page.route('**/workflow-templates', (route) =>
    route.fulfill({ json: [{ id: 'default', name: 'Empty', graph: { nodes: [], edges: [], autoStart: false } }] }),
  );
  const generated = {
    autoStart: false,
    entryNodeId: 'build',
    nodes: [
      { id: 'build', label: 'Build', kind: 'agent', instructions: 'Implement and test the ticket.', dependsOn: [], position: { x: 40, y: 80 } },
      { id: 'review', label: 'Review', kind: 'agent', instructions: 'Review the diff and return findings.', dependsOn: [], position: { x: 340, y: 80 } },
    ],
    edges: [
      { id: 'build-review', source: 'build', target: 'review', label: 'Implementation and checks are complete' },
      { id: 'review-build', source: 'review', target: 'build', label: 'Actionable findings need correction' },
    ],
  };
  await page.route('**/api/graph-assistant', async (route) => {
    expect(route.request().postDataJSON().graph.nodes).toEqual([]);
    await route.fulfill({ json: { message: 'Created build and review with a correction loop.', graph: generated } });
  });
  await page.route('**/api/gantry/api/projects/demo/tickets', (route) => route.fulfill({ json: { id: 'created' } }));
  await page.goto('/?workspace=demo');
  await page.getByRole('button', { name: 'New ticket', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Build with review');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  await page.getByLabel('Graph request', { exact: true }).fill('Create build and review with a correction loop');
  await page.getByRole('button', { name: 'Send request', exact: true }).click();
  await page.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit node Build', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit node Review', exact: true })).toBeVisible();
  const created = page.waitForRequest((request) => request.url().endsWith('/projects/demo/tickets') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Create ticket', exact: true }).click();
  expect((await created).postDataJSON().graph).toEqual(generated);
});
