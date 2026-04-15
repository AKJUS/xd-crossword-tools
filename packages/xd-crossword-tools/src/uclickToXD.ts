// e.g. https://picayune.uclick.com/comics/usaon/data/usaon190124-data.xml
// Which does not actually work, this code would need to be changed to better
// handle formatting
//
import { XMLParser } from "fast-xml-parser"

const fxpParser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "" })

export const uclickXMLToXD = (str: string) => {
  const parsed = fxpParser.parse(str) as any[]
  const root = parsed.find((n: any) => Object.keys(n).some((k) => k !== ":@" && k !== "#text"))!
  const rootKey = Object.keys(root).find((k) => k !== ":@" && k !== "#text")!
  const rootChildren: any[] = root[rootKey]
  const crosswordNode = rootChildren.find((n: any) => "crossword" in n)
  if (!crosswordNode) throw new Error("Could not find crossword element in XML")

  let width = -1
  let metaRaw: Record<string, string> = {}
  let answer = ""
  const downs: string[] = []
  const acrosses: string[] = []

  const cwChildren: any[] = crosswordNode["crossword"]

  // Process all elements
  cwChildren.forEach((element: any) => {
    const name = Object.keys(element).find((k) => k !== ":@" && k !== "#text")
    if (!name) return
    const attrs = element[":@"] || {}

    if (name === "Width") {
      width = Number(attrs.v)
    } else if (name === "AllAnswer") {
      answer = attrs.v.replace(/-/g, ".")
    } else if (name === "across") {
      ;(element[name] as any[]).forEach((clue: any) => {
        const clueName = Object.keys(clue).find((k) => k !== ":@" && k !== "#text")
        if (!clueName || !clueName.startsWith("a")) return
        const clueAttrs = clue[":@"] || {}
        const i = clueName.slice(1)
        const answer = clueAttrs.a
        const c = decodeURIComponent(clueAttrs.c)
        acrosses.push(`${i}. ${c} ~ ${answer}`)
      })
    } else if (name === "down") {
      ;(element[name] as any[]).forEach((clue: any) => {
        const clueName = Object.keys(clue).find((k) => k !== ":@" && k !== "#text")
        if (!clueName || !clueName.startsWith("d")) return
        const clueAttrs = clue[":@"] || {}
        const i = clueName.slice(1)
        const answer = clueAttrs.a
        const c = decodeURIComponent(clueAttrs.c)
        downs.push(`${i}. ${c} ~ ${answer}`)
      })
    } else {
      // Handle metadata
      metaRaw[name] = attrs.v
    }
  })

  const cap = (word: string) => word[0].toUpperCase() + word.slice(1)
  const board = splitToNewLines(answer, width)
  const meta = Object.keys(metaRaw).map((key) => `${cap(key)}: ${(metaRaw[key] || "N/A").trim()}`)

  return `${meta.join("\n")}


${board}


${acrosses.join("\n")}

${downs.join("\n")}
`
}

function splitToNewLines(str: string, width: number) {
  var result = ""
  while (str.length > 0) {
    result += str.substring(0, width) + "\n"
    str = str.substring(width)
  }
  return result
}
