import { readFileSync } from "fs"
import { convertImplicitOrderedXDToExplicitHeaders, shouldConvertToExplicitHeaders } from "./xdparser2.compat"

it("converts a v1 implicit xd to explicit under the hood", async () => {
  const xd = readFileSync("./packages/xd-crossword-tools/tests/puz/alpha-bits.xd", "utf8")
  const explicit = convertImplicitOrderedXDToExplicitHeaders(xd)
  await expect(explicit).toMatchFileSnapshot("./packages/xd-crossword-tools/tests/puz/explicit-alpha-bits.xd")
})

it("correctly knows whether to do the transition", () => {
  const xd = readFileSync("./packages/xd-crossword-tools-parser/src/parser/inputs/alpha-bits.xd", "utf8")
  const explicitXD = readFileSync("./packages/xd-crossword-tools-parser/src/parser/outputs/explicit-alpha-bits.xd", "utf8")

  expect(shouldConvertToExplicitHeaders(xd)).toBeTruthy()
  expect(shouldConvertToExplicitHeaders(explicitXD)).toBeFalsy()
})
