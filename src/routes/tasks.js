const express = require('express');
const prisma = require('../db');
const tasks = require('../services/tasks');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('invalid_id'), { status: 400 });
  return n;
};

// Mail sent from a GMDSS card settles the lead's due reminder here too (throttled; a failure never blocks the list).
const syncGmdss = () => require('../services/gmdss').syncSentToMainAll(prisma).catch((e) => console.error('gmdss sent sync failed', e.message));
router.get('/', wrap(async (req, res) => { await syncGmdss(); res.json(await tasks.listTasks(req.query)); }));
router.get('/summary', wrap(async (_req, res) => { await syncGmdss(); res.json(await tasks.summary()); }));
router.get('/no-next-action', wrap(async (_req, res) => res.json(await tasks.leadsWithoutNext())));
router.get('/meta', wrap(async (_req, res) => {
  const [countries, types] = await Promise.all([
    prisma.lead.findMany({ where: { country: { not: null }, tasks: { some: {} } }, distinct: ['country'], select: { country: true }, orderBy: { country: 'asc' } }),
    prisma.lead.findMany({ where: { segment: { not: null }, tasks: { some: {} } }, distinct: ['segment'], select: { segment: true }, orderBy: { segment: 'asc' } }),
  ]);
  res.json({ taskTypes: tasks.TYPES, statuses: tasks.STATUSES, priorities: tasks.PRIORITIES, countries: countries.map((c) => c.country), leadTypes: types.map((s) => s.segment) });
}));

router.post('/', wrap(async (req, res) => {
  res.status(201).json(await tasks.createTask(id(req.body.leadId), req.body));
}));
router.patch('/:id', wrap(async (req, res) => res.json(await tasks.updateTask(id(req.params.id), req.body || {}))));
router.post('/:id/complete', wrap(async (req, res) => res.json(await tasks.completeTask(id(req.params.id), { next: req.body && req.body.next }))));
router.post('/:id/reschedule', wrap(async (req, res) => res.json(await tasks.rescheduleTask(id(req.params.id), req.body || {}))));
router.post('/:id/next-action', wrap(async (req, res) => res.json(await tasks.setNextAction(id(req.params.id)))));
router.delete('/:id', wrap(async (req, res) => { await tasks.deleteTask(id(req.params.id)); res.status(204).end(); }));

module.exports = router;
