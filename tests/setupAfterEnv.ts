import { waitForBackgroundTasks } from '../src/utils/background';

afterEach(async () => {
  await waitForBackgroundTasks();
});
