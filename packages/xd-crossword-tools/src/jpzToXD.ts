import { Clue, CrosswordJSON, Tile } from "xd-crossword-tools-parser"
import { JSONToXD } from "./JSONtoXD"
import parse from "xml-parser"
import { LetterTile } from "xd-crossword-tools-parser"

/**
 * Extracts the raw inner XML of every <clue> element, keyed by its `word`
 * attribute. The xml-parser library used elsewhere in this file does not
 * preserve mixed content (text after child tags is dropped), so for clues
 * with inline markup like <i>...</i> we have to read the original XML.
 */
function extractRawClueInnerXML(xmlString: string): { [wordId: string]: string } {
  const map: { [wordId: string]: string } = {}
  const clueRegex = /<clue\b([^>]*)>([\s\S]*?)<\/clue>/g
  let m: RegExpExecArray | null
  while ((m = clueRegex.exec(xmlString)) !== null) {
    const attrs = m[1]
    const inner = m[2]
    const wordMatch = attrs.match(/\bword\s*=\s*["']([^"']*)["']/)
    if (wordMatch) map[wordMatch[1]] = inner
  }
  return map
}

/**
 * Converts JPZ-style inline HTML markup inside a clue body to xd markup.
 * Supports <i>/<em>, <b>/<strong>, <u>, <s>/<strike>/<del>, <a href>, and <img>.
 * Strips an optional wrapping <span> and any unknown tags (keeping their text).
 */
function convertInlineXMLToXDMarkup(xml: string): string {
  let result = xml.trim()

  // Strip a single outer <span>...</span> wrapper if present
  const spanMatch = result.match(/^<span\b[^>]*>([\s\S]*)<\/span>\s*$/)
  if (spanMatch) result = spanMatch[1].trim()

  // <img src alt /> → {![src|alt]!}
  result = result.replace(/<img\b([^>]*?)\/?>(?:\s*<\/img>)?/g, (_match, attrs) => {
    const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/)
    const altMatch = attrs.match(/\balt\s*=\s*["']([^"']*)["']/)
    const src = srcMatch ? srcMatch[1] : ""
    const alt = altMatch ? altMatch[1] : ""
    return alt ? `{![${src}|${alt}]!}` : `{![${src}]!}`
  })

  const conversions: Array<{ tags: string[]; open: string; close: string }> = [
    { tags: ["i", "em"], open: "{/", close: "/}" },
    { tags: ["b", "strong"], open: "{*", close: "*}" },
    { tags: ["u"], open: "{_", close: "_}" },
    { tags: ["s", "strike", "del"], open: "{-", close: "-}" },
  ]

  // Convert paired inline tags. Repeat until stable so nested tags collapse
  // innermost-first (after the inner tag is replaced with xd markup it no
  // longer contains "<", so the outer regex matches).
  let prev: string
  do {
    prev = result
    for (const { tags, open, close } of conversions) {
      const re = new RegExp(`<(${tags.join("|")})\\b[^>]*>([^<]*?)</\\1>`, "g")
      result = result.replace(re, (_m, _tag, content) => `${open}${content}${close}`)
    }
    // <a href="URL">TEXT</a> → {@TEXT|URL@}
    result = result.replace(/<a\b([^>]*)>([^<]*?)<\/a>/g, (_m, attrs, text) => {
      const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']*)["']/)
      const href = hrefMatch ? hrefMatch[1] : ""
      return `{@${text}|${href}@}`
    })
  } while (result !== prev)

  // Drop any remaining unknown tags but preserve their text content.
  result = result.replace(/<\/?[^>]+>/g, "")

  return result
}

/**
 * Replaces the body of every `<clue>` element with a flat `<span>` containing
 * just its text content, stripping inline child tags like `<i>` or `<b>`.
 *
 * The xml-parser library used here cannot handle mixed content (it loses any
 * text that appears after a child tag), and a broken parse cascades — sibling
 * `<clues>` elements then go missing too. Pre-flattening clue bodies keeps the
 * surrounding structure parseable. The original XML is still inspected via
 * `extractRawClueInnerXML` to recover the inline markup.
 */
function preprocessClueBodiesForParser(xml: string): string {
  return xml.replace(/(<clue\b[^>]*>)([\s\S]*?)(<\/clue>)/g, (_match, open: string, inner: string, close: string) => {
    const flattened = inner.replace(/<[^>]+>/g, "")
    return `${open}<span>${flattened}</span>${close}`
  })
}

/**
 * Takes a jpz xml string and converts it to an xd file.
 */
export function jpzToXD(xmlString: string): string {
  const rawClueInnerByWordId = extractRawClueInnerXML(xmlString)
  const parsed = parse(preprocessClueBodiesForParser(xmlString))

  const rectangularPuzzle = parsed.root.children.find((child: { name: string }) => child.name === "rectangular-puzzle")
  if (!rectangularPuzzle) throw new Error("Could not find rectangular-puzzle element in JPZ")

  const metadataEl = rectangularPuzzle.children.find((child: { name: string }) => child.name === "metadata")
  if (!metadataEl) throw new Error("Could not find metadata element in JPZ")

  const crosswordEl = rectangularPuzzle.children.find((child: { name: string }) => child.name === "crossword")
  if (!crosswordEl) throw new Error("Could not find crossword element in JPZ")

  const gridEl = crosswordEl.children.find((child: { name: string }) => child.name === "grid")
  if (!gridEl) throw new Error("Could not find grid element in JPZ")

  const cluesEls = crosswordEl.children.filter((child: { name: string }) => child.name === "clues")
  if (cluesEls.length !== 2) throw new Error("Expected exactly two clues elements in JPZ")

  const title = metadataEl.children.find((c: { name: string }) => c.name === "title")?.content ?? "Untitled"

  // Grabbing metadata from the JPZ file
  const meta: CrosswordJSON["meta"] = {
    title,
    author: metadataEl.children.find((c: { name: string }) => c.name === "creator")?.content ?? "Unknown Author",
    editor: title.includes("edited by") ? title.split("edited by")[1].trim() : "",
    date: metadataEl.children.find((c: { name: string }) => c.name === "created_at")?.content ?? "",
    copyright: metadataEl.children.find((c: { name: string }) => c.name === "copyright")?.content ?? "",
  }

  // Extracting the grid
  const gridWidth = parseInt(gridEl.attributes.width, 10)
  const gridHeight = parseInt(gridEl.attributes.height, 10)
  const tiles: Tile[][] = Array.from({ length: gridHeight }, () => Array(gridWidth).fill({ type: "blank" }))
  const numberPositions: { [num: string]: { row: number; col: number } } = {}

  // Track cells with bars and their combinations
  const cellBars: { [key: string]: { left?: boolean; top?: boolean } } = {}
  let hasAnyBars = false

  for (const cell of gridEl.children) {
    if (cell.name !== "cell") continue
    const x = parseInt(cell.attributes.x, 10) - 1 // 1-based to 0-based
    const y = parseInt(cell.attributes.y, 10) - 1 // 1-based to 0-based

    if (cell.attributes.type === "block") {
      tiles[y][x] = { type: "blank" }
    } else {
      // Check if there are any definitions for bars
      const barAttributes = ["left-bar", "right-bar", "top-bar", "bottom-bar"]
      if (barAttributes.some((attr) => cell.attributes[attr] === "true")) meta.form = "barred"

      const tile: LetterTile = {
        type: "letter",
        letter: cell.attributes.solution ?? "?", // Use '?' if solution missing
      }

      if (cell.attributes.number) {
        numberPositions[cell.attributes.number] = { row: y, col: x }
      }

      // Collect bar information for this cell
      const bars: { left?: boolean; top?: boolean } = {}
      if (cell.attributes["left-bar"] === "true") {
        bars.left = true
        hasAnyBars = true
      }
      if (cell.attributes["top-bar"] === "true") {
        bars.top = true
        hasAnyBars = true
      }

      // Note: right-bar and bottom-bar are converted to left-bar and top-bar on adjacent cells
      // For the XD format, we need to store them on the adjacent cells
      if (cell.attributes["right-bar"] === "true" && x < gridWidth - 1) {
        const key = `${y},${x + 1}`
        if (!cellBars[key]) cellBars[key] = {}
        cellBars[key].left = true
        hasAnyBars = true
      }
      if (cell.attributes["bottom-bar"] === "true" && y < gridHeight - 1) {
        const key = `${y + 1},${x}`
        if (!cellBars[key]) cellBars[key] = {}
        cellBars[key].top = true
        hasAnyBars = true
      }

      if (bars.left || bars.top) {
        const key = `${y},${x}`
        if (!cellBars[key]) cellBars[key] = {}
        if (bars.left) cellBars[key].left = true
        if (bars.top) cellBars[key].top = true
      }

      // TODO: Rebuses
      tiles[y][x] = tile
    }
  }

  // Extract word definitions to get answers
  const wordEls = crosswordEl.children.filter((child: { name: string }) => child.name === "word")
  const wordAnswers: { [wordId: string]: string } = {}

  for (const wordEl of wordEls) {
    const wordID = wordEl.attributes.id
    const cellsEls = wordEl.children.filter((child: { name: string }) => child.name === "cells")
    let answer = ""

    for (const cellEl of cellsEls) {
      const x = parseInt(cellEl.attributes.x, 10) - 1
      const y = parseInt(cellEl.attributes.y, 10) - 1
      const tile = tiles[y][x]
      if (tile.type === "letter") {
        answer += tile.letter
      }
    }

    wordAnswers[wordID] = answer
  }

  // Grabbing the clues
  const clues: CrosswordJSON["clues"] = { across: [], down: [] }

  for (const cluesEl of cluesEls) {
    const titleEl = cluesEl.children.find((c: { name: string }) => c.name === "title")
    const direction = (titleEl?.children?.length || 0) > 0 ? titleEl?.children[0]?.content?.toLowerCase() : titleEl?.content?.toLowerCase()

    if (!direction || (direction !== "across" && direction !== "down")) continue

    for (const clueEl of cluesEl.children) {
      if (clueEl.name !== "clue") continue

      const num = clueEl.attributes.number
      const wordID = clueEl.attributes.word
      let text = ""

      // Prefer the raw inner XML so inline markup (e.g. <i>...</i>) is
      // preserved — xml-parser drops mixed content after the first child tag.
      const rawInner = wordID ? rawClueInnerByWordId[wordID] : undefined
      if (rawInner !== undefined) {
        text = convertInlineXMLToXDMarkup(rawInner)
      } else if (clueEl.children.length > 0) {
        // Fallback: sometimes the clue text is wrapped in a span element
        const textEl = clueEl.children.find((c: { name: string }) => c.name === "span")
        text = textEl?.content ?? ""
      } else {
        // Fallback: sometimes its not
        text = clueEl.content ?? ""
      }
      const pos = numberPositions[num]
      if (!pos) {
        console.warn(`Could not find position for clue number ${num}`)
        continue
      }

      const answer = wordAnswers[wordID] || ""

      // Skip clues without valid answers
      if (!answer || answer.length === 0) {
        console.warn(`Skipping clue ${num} with empty answer`)
        continue
      }

      const clue: Clue = {
        number: parseInt(num, 10),
        body: text,
        position: { col: pos.col, index: pos.row },
        answer: answer,
        direction: direction.toUpperCase() as "across" | "down",
        display: [],
        tiles: [],
      }
      clues[direction].push(clue)
    }
  }

  // Sort clues by number
  clues.across.sort((a, b) => a.number - b.number)
  clues.down.sort((a, b) => a.number - b.number)

  // Create Design section if there are bars
  let design = undefined
  if (hasAnyBars) {
    // Create unique style combinations
    const styleMap = new Map<string, string>()
    const positions: string[][] = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(""))

    // Generate style letters starting from 'A'
    let styleLetterCode = 65 // ASCII for 'A'

    for (const [cellKey, bars] of Object.entries(cellBars)) {
      const [y, x] = cellKey.split(",").map(Number)

      // Create a unique key for this bar combination
      const barKey = `${bars.left ? "L" : ""}${bars.top ? "T" : ""}`

      if (barKey && !styleMap.has(barKey)) {
        const styleLetter = String.fromCharCode(styleLetterCode++)
        const barStyles: string[] = []

        if (bars.left) barStyles.push("bar-left: true")
        if (bars.top) barStyles.push("bar-top: true")

        styleMap.set(barKey, styleLetter)
      }

      if (barKey) {
        positions[y][x] = styleMap.get(barKey) || ""
      }
    }

    // Convert styleMap to the format expected by the Design section
    const styles: { [key: string]: { [prop: string]: string } } = {}
    for (const [barKey, letter] of styleMap) {
      const styleObj: { [prop: string]: string } = {}
      if (barKey.includes("L")) styleObj["bar-left"] = "true"
      if (barKey.includes("T")) styleObj["bar-top"] = "true"
      styles[letter] = styleObj
    }

    design = {
      styles,
      positions,
    }
  }

  const crosswordJSON: CrosswordJSON = {
    meta,
    tiles,
    clues,
    notes: "",
    rebuses: {},
    unknownSections: {},
    report: { success: true, errors: [], warnings: [] },
    ...(design && { design }),
  }

  // For now, log the bars we found
  return JSONToXD(crosswordJSON)
}
