import { calculatePercentageUsed } from "../util/storage.js";

test("ensure percentage used values are accurate", () => {
  expect(calculatePercentageUsed(30, 100)).toEqual(30);

  expect(calculatePercentageUsed(1507, 35750)).toEqual(4);

  expect(calculatePercentageUsed(33819, 35750)).toEqual(95);

  expect(calculatePercentageUsed(140, 70)).toEqual(200);

  expect(calculatePercentageUsed(0, 5)).toEqual(200);
});
