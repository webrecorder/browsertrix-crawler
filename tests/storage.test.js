import { calculatePercentageUsed, checkDiskUtilization } from "../dist/util/storage.js";


test("ensure calculatePercentageUsed returns expected values", () => {
  expect(calculatePercentageUsed(30, 100)).toEqual(30);

  expect(calculatePercentageUsed(1507, 35750)).toEqual(4);

  expect(calculatePercentageUsed(33819, 35750)).toEqual(95);

  expect(calculatePercentageUsed(140, 70)).toEqual(200);

  expect(calculatePercentageUsed(0, 5)).toEqual(0);
});


test("verify end-to-end disk utilization not exceeded threshold", async () => {

  const params = {
    diskUtilization: 90,
    combineWARC: true,
    generateWACZ: true
  };

  const mockDfOutput = `\
Filesystem     1K-blocks      Used Available Use% Mounted on
grpcfuse       1000000      285000    715000  28% /crawls`;

  // with combineWARC + generateWACZ, projected is 285k + 4 * 5k = 310k = 31%
  // does not exceed 90% threshold
  const returnValue = await checkDiskUtilization(params, 5000 * 1024, mockDfOutput);
  expect(returnValue).toEqual({
    stop: false,
    used: 28,
    projected: 31,
    threshold: 90
  });
});


test("verify end-to-end disk utilization exceeds threshold", async () => {

  const params = {
    diskUtilization: 90,
    combineWARC: false,
    generateWACZ: true
  };

  const mockDfOutput = `\
Filesystem     1K-blocks  Used Available Use% Mounted on
grpcfuse       100000    85000     15000  85% /crawls`;

  // with generateWACZ, projected is 85k + 3k x 2 = 91k = 91%
  // exceeds 90% threshold
  const returnValue = await checkDiskUtilization(params, 3000 * 1024, mockDfOutput);
  expect(returnValue).toEqual({
    stop: true,
    used: 85,
    projected: 91,
    threshold: 90
  });
});
