import { postIdeaForVoting } from '../src/launchkit/services/communityVoting.ts';

const testIdea = {
  id: 'test-' + Date.now(),
  name: 'Test Token',
  ticker: 'TEST',
  description: 'A test token to verify voting reactions work',
  confidence: 0.75,
  theme: 'testing',
  mascot: 'A friendly robot testing things',
  timestamp: new Date().toISOString(),
};

console.log('Posting test idea for voting...');
const result = await postIdeaForVoting(testIdea, 'Testing the voting system');
console.log('Result:', result);
