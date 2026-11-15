// The outline overview (SPEC §6.1, decision #70): a picture of a region too full to export in
// full detail, drawn straight onto a 2D canvas from each shape's geometry instead of through
// tldraw's SVG export.
//
// Why it exists: editor.toImage builds an SVG of every shape it draws, at about 2 ms a shape
// (measured on a 4,000-shape board: 6.5 s of SVG, 8.3 s with the raster), so a full-detail picture
// of a large board outruns the 12 s export bound and every /exec that asks for one. Drawing outlines
// costs about 0.05 ms a shape. What it leaves out is text, which on a region that full is drawn
// smaller than a few pixels anyway; frame names, the landmarks of a large board, are kept and
// drawn at a size that reads. [#70] The caption carries the rest, because a reader may have only
// the PNG: it tells the drawing agent to zoom with ?bounds= before it judges legibility, and tells
// the blind critic, which receives the PNG and nothing else, that this picture cannot be judged
// for text.
//
// The same file holds what keeps a region's picture bounded by the region (regionShapes) and the
// full-detail picture of a region that cuts through a frame (drawRegion).

import { getArrowInfo, getColorValue } from 'tldraw'
import type { Box, Editor, TLShape, TLShapeId, TLThemeColors } from 'tldraw'

const CAPTION_PX = 28
const FRAME_LABEL_PX = 13
// [#70] The side of the filled head marking an arrow's direction, in picture pixels at any scale.
const ARROWHEAD_PX = 7

export type OverviewArea = { bounds: Box; scale: number; padding: number }

type Point = { x: number; y: number }
type FrameLabel = { name: string; x: number; y: number; w: number }

// [#70] What a region's picture holds (SPEC §6.1). `meets` is every shape whose page bounds meet
// the region, at any depth: the spatial index holds each shape, not only the page's children, so
// a frame's member that meets the region is there on its own. The picture's cost follows its size.
//
// toImage draws every descendant of each id it is given (getSvgJsx.tsx: getShapeAndDescendantIds),
// so `ids` passes a shape only when its whole subtree meets the region, and only at the top of such
// a subtree. A container that reaches outside the region is left out and its members that meet it
// stand in for it, so what toImage expands to is `meets` less those containers. A frame left out
// this way is in `frames`, in page order, for drawRegion to draw by its outline and name; a group
// draws nothing of its own, so one left out needs nothing in its place.
export type RegionShapes = { meets: Set<TLShapeId>; ids: TLShapeId[]; frames: TLShape[] }

export function regionShapes(editor: Editor, bounds: Box): RegionShapes {
  const meets = editor.getShapeIdsInsideBounds(bounds)
  // Whether a shape and all of its descendants meet the region. A child that misses it settles
  // its container at once, so a large frame costs one look at its children, not a walk of them all.
  const whole = new Map<TLShapeId, boolean>()
  const isWhole = (id: TLShapeId): boolean => {
    let known = whole.get(id)
    if (known === undefined) {
      known = meets.has(id) && editor.getSortedChildIdsForParent(id).every(isWhole)
      whole.set(id, known)
    }
    return known
  }

  const ids: TLShapeId[] = []
  const split = new Set<TLShapeId>()
  for (const id of meets) {
    if (isWhole(id)) {
      // A whole parent brings this shape in already. A parent that is not whole means no ancestor is.
      const parent = editor.getShapeParent(id)
      if (!parent || !isWhole(parent.id)) ids.push(id)
    } else if (editor.getShape(id)?.type === 'frame') {
      split.add(id)
    }
  }
  // getSvgJsx exports a lone frame id as the frame's contents, without the frame itself and on the
  // frame's fill. Passing its children with it draws the same subtree with the frame shown; a lone
  // frame with no children is drawn by drawRegion instead.
  if (ids.length === 1 && editor.isShapeFrameLike(ids[0])) {
    const children = editor.getSortedChildIdsForParent(ids[0])
    if (children.length > 0) ids.push(...children)
    else split.add(ids.pop()!)
  }

  const frames = split.size === 0 ? [] : editor.getCurrentPageShapesSorted().filter((s) => split.has(s.id))
  return { meets, ids, frames }
}

// [#70] The full-detail picture of a region whose `frames` were left out of the export
// (regionShapes): each frame's body, and tldraw's export of `ids` on a clear background, stacked in
// page order (getCurrentPageShapesSorted), so a shape behind a frame on the operator's screen is
// behind it here too, and the frame's own members, which follow it in that order, are on top. A run
// of `ids` with no frame between them is one export; the frames' names go on top of everything, held
// inside the picture so a zoom deep in a frame still names it. An empty `ids` draws the frames alone,
// or the region's background when there are none.
export async function drawRegion(
  editor: Editor,
  ids: TLShapeId[],
  frames: TLShape[],
  area: OverviewArea,
): Promise<Blob> {
  const { bounds, scale, padding } = area

  // The layers, bottom to top: a frame's body, or a run of ids exported together.
  const order = new Map<TLShapeId, number>()
  editor.getCurrentPageShapesSorted().forEach((s, i) => order.set(s.id, i))
  const at = (id: TLShapeId) => order.get(id) ?? Number.MAX_SAFE_INTEGER
  const stacked = [
    ...ids.map((id) => ({ at: at(id), id })),
    ...frames.map((frame) => ({ at: at(frame.id), frame })),
  ].sort((a, b) => a.at - b.at)
  type Layer = { frame: TLShape } | { ids: TLShapeId[]; image?: ImageBitmap }
  const layers: Layer[] = []
  for (const item of stacked) {
    const last = layers[layers.length - 1]
    if ('frame' in item) layers.push({ frame: item.frame })
    else if (last && 'ids' in last) last.ids.push(item.id)
    else layers.push({ ids: [item.id] })
  }

  for (const [i, layer] of layers.entries()) {
    if (!('ids' in layer)) continue
    // A lone frame id exports as the frame's contents without the frame (regionShapes); a run cut
    // down to one by the frames around it gets its children too, or, with none, is drawn as a frame.
    if (layer.ids.length === 1 && editor.isShapeFrameLike(layer.ids[0])) {
      const children = editor.getSortedChildIdsForParent(layer.ids[0])
      const frame = editor.getShape(layer.ids[0])
      if (children.length > 0) layer.ids.push(...children)
      else if (frame) {
        layers[i] = { frame }
        continue
      }
    }
    const { blob } = await editor.toImage(layer.ids, { format: 'png', background: false, bounds, scale, pixelRatio: 1, padding })
    layer.image = await createImageBitmap(blob)
  }

  // Every export shares the bounds, scale and padding, so each is the picture's size.
  const first = layers.find((l): l is Layer & { image: ImageBitmap } => 'image' in l && !!l.image)?.image
  const w = first?.width ?? Math.max(1, Math.ceil((bounds.w + padding * 2) * scale))
  const h = first?.height ?? Math.max(1, Math.ceil((bounds.h + padding * 2) * scale))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('region: no 2d context')

  const colors = editor.getCurrentTheme().colors[editor.getColorMode()]
  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, w, h)

  const toPixel = pagePixels(area, 0)
  const labels: FrameLabel[] = []
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  for (const layer of layers) {
    if ('ids' in layer) {
      if (layer.image) {
        ctx.drawImage(layer.image, 0, 0)
        layer.image.close()
      }
      continue
    }
    const points = pagePoints(editor, layer.frame).map(toPixel)
    if (points.length === 0) continue
    tracePath(ctx, points, true)
    ctx.fillStyle = getColorValue(colors, 'black', 'frameFill')
    ctx.fill()
    ctx.strokeStyle = getColorValue(colors, 'black', 'frameStroke')
    ctx.stroke()
    const label = frameLabel(editor, layer.frame, toPixel, scale)
    if (label) labels.push(label)
  }
  drawFrameNames(ctx, colors, labels, 0, w)

  return canvas.convertToBlob({ type: 'image/png' })
}

// Draw the shapes in `shapes` that meet `area` as outlines, under a caption naming how many were
// drawn. [#70] The caller passes every shape to consider, descendants included: the whole page for
// the bird's-eye, regionShapes' `meets` for a region. An empty `shapes` draws the region's
// background alone, with no caption: a region with nothing in it.
export async function drawOverview(editor: Editor, shapes: ReadonlySet<TLShapeId>, area: OverviewArea): Promise<Blob> {
  const { bounds, scale, padding } = area
  const caption = shapes.size > 0 ? CAPTION_PX : 0
  const w = Math.max(1, Math.ceil((bounds.w + padding * 2) * scale))
  const h = Math.max(1, Math.ceil((bounds.h + padding * 2) * scale)) + caption
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('overview: no 2d context')

  const colors = editor.getCurrentTheme().colors[editor.getColorMode()]
  ctx.fillStyle = colors.background
  ctx.fillRect(0, 0, w, h)

  // Page point → pixel in the picture, below the caption strip.
  const toPixel = pagePixels(area, caption)

  const labels: FrameLabel[] = []
  let drawn = 0
  ctx.lineWidth = 1
  ctx.lineJoin = 'round'
  for (const shape of editor.getCurrentPageShapesSorted()) {
    if (!shapes.has(shape.id)) continue
    const pageBounds = editor.getShapePageBounds(shape)
    if (!pageBounds || !pageBounds.collides(bounds)) continue
    if (shape.type === 'group') continue // a group draws nothing of its own
    const props = shape.props as { color?: string; fill?: string }
    const color = props.color ?? 'black'
    const solid = getColorValue(colors, color, 'solid')

    const geometry = editor.getShapeGeometry(shape)
    const points = pagePoints(editor, shape).map(toPixel)
    if (points.length === 0) continue
    drawn++
    // [#70] An arrow's geometry is a Group2d, which is always closed (Group2d.ts), and a line is
    // open by nature: both are stroked as the open paths they are, never closed or filled.
    const open = shape.type === 'arrow' || shape.type === 'line'
    tracePath(ctx, points, geometry.isClosed && !open)

    switch (shape.type) {
      case 'note':
        ctx.fillStyle = getColorValue(colors, color, 'noteFill')
        ctx.fill()
        break
      case 'text':
        // Text too small to read is drawn as a tinted block where it sits.
        ctx.globalAlpha = 0.35
        ctx.fillStyle = solid
        ctx.fill()
        ctx.globalAlpha = 1
        break
      case 'frame': {
        // Frames draw in black, as tldraw draws them without its showColors option.
        ctx.strokeStyle = getColorValue(colors, 'black', 'frameStroke')
        ctx.stroke()
        const label = frameLabel(editor, shape, toPixel, scale)
        if (label) labels.push(label)
        break
      }
      case 'arrow':
        ctx.strokeStyle = solid
        ctx.stroke()
        ctx.fillStyle = solid
        drawArrowheads(ctx, editor, shape, points)
        break
      default:
        if (!open && geometry.isClosed && props.fill && props.fill !== 'none') {
          ctx.fillStyle = getColorValue(colors, color, 'semi')
          ctx.fill()
        }
        ctx.strokeStyle = solid
        ctx.stroke()
    }
  }

  // Frame names last, over what the frames hold.
  drawFrameNames(ctx, colors, labels, caption, w)

  if (caption) {
    ctx.fillStyle = colors.text
    ctx.font = '14px sans-serif'
    ctx.textBaseline = 'middle'
    const text = `Overview: ${drawn} shapes drawn as outlines; text is not shown, so legibility cannot be judged here. For detail, GET /image?bounds=x,y,w,h on a smaller region.`
    ctx.fillText(fitText(ctx, text, w - 12), 6, caption / 2)
  }

  return canvas.convertToBlob({ type: 'image/png' })
}

// Page point → pixel in a picture of `area`, `top` pixels below its top edge.
function pagePixels({ bounds, scale, padding }: OverviewArea, top: number): (p: Point) => Point {
  const ox = bounds.x - padding
  const oy = bounds.y - padding
  return (p) => ({ x: (p.x - ox) * scale, y: (p.y - oy) * scale + top })
}

// A shape's outline in page space, from its geometry (labels excluded, as Geometry2d.vertices does).
function pagePoints(editor: Editor, shape: TLShape): Point[] {
  const transform = editor.getShapePageTransform(shape)
  return editor.getShapeGeometry(shape).vertices.map((p) => transform.applyToPoint(p))
}

function tracePath(ctx: OffscreenCanvasRenderingContext2D, points: Point[], closed: boolean) {
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  if (closed) ctx.closePath()
}

// Where a frame's name goes: its top-left corner in the picture, and its width there.
function frameLabel(editor: Editor, frame: TLShape, toPixel: (p: Point) => Point, scale: number): FrameLabel | null {
  const name = (frame.props as { name?: string }).name?.trim()
  const pageBounds = editor.getShapePageBounds(frame)
  if (!name || !pageBounds) return null
  const { x, y } = toPixel(pageBounds)
  return { name, x, y, w: pageBounds.w * scale }
}

// Each frame's name just above its top edge, kept inside the picture: below `top` (the caption
// strip) and within the part of the frame the picture shows, so a region inside a frame still names
// it. A frame whose shown part is too narrow to carry a name gets none.
function drawFrameNames(
  ctx: OffscreenCanvasRenderingContext2D,
  colors: TLThemeColors,
  labels: FrameLabel[],
  top: number,
  width: number,
) {
  ctx.font = `${FRAME_LABEL_PX}px sans-serif`
  ctx.textBaseline = 'bottom'
  for (const { name, x, y, w } of labels) {
    const left = Math.max(x, 0)
    const room = Math.min(x + w, width) - left
    if (room < 40) continue
    const label = fitText(ctx, name, room)
    const base = Math.max(top + FRAME_LABEL_PX + 2, y - 1)
    ctx.fillStyle = colors.background
    ctx.fillRect(left, base - FRAME_LABEL_PX - 2, ctx.measureText(label).width + 4, FRAME_LABEL_PX + 3)
    ctx.fillStyle = colors.text
    ctx.fillText(label, left + 2, base)
  }
}

// [#70] With its text gone, an arrow's heads are what shows the flow, so each terminal that carries
// one (getArrowInfo's start.arrowhead / end.arrowhead, 'arrow' at the end by default) gets a small
// filled head in the current fill. `points` are the arrow's body in picture pixels; Edge2d, Arc2d
// and the elbow route all run them from the start terminal to the end, so each head points along
// the body's last stretch into its terminal.
function drawArrowheads(ctx: OffscreenCanvasRenderingContext2D, editor: Editor, shape: TLShape, points: Point[]) {
  const info = getArrowInfo(editor, shape.id)
  if (!info?.isValid || points.length < 2) return
  if (info.end.arrowhead !== 'none') drawHead(ctx, points, points.length - 1, -1)
  if (info.start.arrowhead !== 'none') drawHead(ctx, points, 0, 1)
}

// A filled head with its tip at points[tip], pointing away from the first point at least a pixel
// back along the body (stepping by `step`).
function drawHead(ctx: OffscreenCanvasRenderingContext2D, points: Point[], tip: number, step: 1 | -1) {
  const end = points[tip]
  for (let i = tip + step; i >= 0 && i < points.length; i += step) {
    const dx = end.x - points[i].x
    const dy = end.y - points[i].y
    const length = Math.hypot(dx, dy)
    if (length < 1) continue
    const ux = dx / length
    const uy = dy / length
    const bx = end.x - ux * ARROWHEAD_PX
    const by = end.y - uy * ARROWHEAD_PX
    const half = ARROWHEAD_PX / 2
    ctx.beginPath()
    ctx.moveTo(end.x, end.y)
    ctx.lineTo(bx - uy * half, by + ux * half)
    ctx.lineTo(bx + uy * half, by - ux * half)
    ctx.closePath()
    ctx.fill()
    return
  }
}

// Cut `text` with an ellipsis so it fits `width` pixels in the context's current font.
function fitText(ctx: OffscreenCanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1)
  return `${cut}…`
}
