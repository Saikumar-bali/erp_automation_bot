import fs from 'node:fs';

const INPUT_FILE = process.env.INPUT_FILE || 'data/fleet_erp_updates.json';
const raw = fs.readFileSync(INPUT_FILE, 'utf8');
const data = JSON.parse(raw);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertTask(task, section, index) {
  assert(task && typeof task === 'object', `${section}[${index}] must be an object`);
  assert(typeof task.subject === 'string' && task.subject.trim(), `${section}[${index}].subject is required`);
  assert(typeof task.status === 'string' && task.status.trim(), `${section}[${index}].status is required`);
  assert(typeof task.priority === 'string' && task.priority.trim(), `${section}[${index}].priority is required`);
  assert(typeof task.description === 'string' && task.description.trim(), `${section}[${index}].description is required`);

  if (task.from) assert(!Number.isNaN(Date.parse(task.from)), `${section}[${index}].from must be a valid date`);
  if (task.to) assert(!Number.isNaN(Date.parse(task.to)), `${section}[${index}].to must be a valid date`);
}

assert(typeof data.erpProject === 'string' && data.erpProject.trim(), 'erpProject is required');
assert(data.source && typeof data.source === 'object', 'source object is required');
assert(typeof data.source.repository === 'string' && data.source.repository.trim(), 'source.repository is required');
assert(typeof data.source.lastUpdatedAsiaKolkata === 'string' && data.source.lastUpdatedAsiaKolkata.trim(), 'source.lastUpdatedAsiaKolkata is required');
assertTask(data.dailySummaryTask, 'dailySummaryTask', 0);
assert(Array.isArray(data.completedTasks), 'completedTasks must be an array');
assert(Array.isArray(data.nextTasks), 'nextTasks must be an array');

data.completedTasks.forEach((task, index) => assertTask(task, 'completedTasks', index));
data.nextTasks.forEach((task, index) => assertTask(task, 'nextTasks', index));

const subjects = new Set();
for (const [section, tasks] of [['dailySummaryTask', [data.dailySummaryTask]], ['completedTasks', data.completedTasks], ['nextTasks', data.nextTasks]]) {
  for (const task of tasks) {
    const key = task.subject.trim().toLowerCase();
    assert(!subjects.has(key), `Duplicate subject found: ${task.subject} in ${section}`);
    subjects.add(key);
  }
}

console.log('Fleet ERP update payload validation passed.');
console.log(`Project: ${data.erpProject}`);
console.log(`Daily summary: 1`);
console.log(`Completed tasks: ${data.completedTasks.length}`);
console.log(`Next tasks: ${data.nextTasks.length}`);
console.log(`Total tasks: ${1 + data.completedTasks.length + data.nextTasks.length}`);
