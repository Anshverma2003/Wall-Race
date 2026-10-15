/**
 * "How to play" tutorial: the basics, as short looping demos on a 7×7 board.
 *
 * Coordinates are GameModel cells (row 0 = P1's start). The tutorial shows
 * the board from P1's side, so "you" (red, P1) start at the bottom and race
 * to the top row; the opponent (blue, P2) comes the other way.
 *
 * Each frame is a full position:
 *   p1, p2   pawn cells
 *   walls    [{o, r, c, by}] placed so far
 *   turn     whose turn it is (0 = you)
 *   showMoves  true → highlight your legal squares (as in a real game)
 *   ghost    {wall, ok} – a wall outline; ok=false shows a forbidden wall
 *   hold     how long to show this frame (ms)
 */

export const TUTORIAL_SIZE = 7;

const h = (r, c, by = 0) => ({ o: 'h', r, c, by });

/** Builds frames by applying small changes to the previous one. */
function script(start, ...changes) {
  const frames = [{ walls: [], turn: 0, ...start }];
  for (const change of changes) {
    const prev = frames[frames.length - 1];
    const next = { ...prev, showMoves: false, ghost: null, hold: undefined, ...change };
    if (change.addWall) next.walls = [...prev.walls, change.addWall];
    delete next.addWall;
    frames.push(next);
  }
  return frames;
}

export const TUTORIAL_STEPS = Object.freeze([
  {
    title: 'Reach the other side',
    text: "You're red and start at the bottom. Be the first to reach the far side – the tinted row at the top. Your opponent (blue) races the other way.",
    frames: script(
      { p1: { r: 0, c: 3 }, p2: { r: 6, c: 3 } },
      { p1: { r: 1, c: 3 }, turn: 1 },
      { p2: { r: 5, c: 3 }, turn: 0 },
      { p1: { r: 2, c: 3 }, turn: 1 },
      { p2: { r: 4, c: 3 }, turn: 0 },
      { p1: { r: 3, c: 3 }, turn: 1 },
      { p2: { r: 4, c: 2 }, turn: 0 },
      { p1: { r: 4, c: 3 }, turn: 1 },
      { p2: { r: 3, c: 2 }, turn: 0 },
      { p1: { r: 5, c: 3 }, turn: 1 },
      { p2: { r: 2, c: 2 }, turn: 0 },
      { p1: { r: 6, c: 3 }, turn: 1, hold: 2200 },
    ),
  },
  {
    title: 'Move one square',
    text: 'On your turn you can move one square: up, down, left or right – never diagonally. The dots show where you can go.',
    frames: script(
      { p1: { r: 2, c: 3 }, p2: { r: 5, c: 3 } },
      { showMoves: true, hold: 1500 },
      { p1: { r: 3, c: 3 } },
      { showMoves: true, hold: 1500 },
      { p1: { r: 3, c: 4 } },
      { showMoves: true, hold: 1500 },
      { p1: { r: 2, c: 4 } },
      { showMoves: true, hold: 1500 },
      { p1: { r: 2, c: 3 } },
    ),
  },
  {
    title: 'Or place a wall',
    text: "Instead of moving, you can place a wall between two dots. Walls block both players – use them to make your opponent's path longer. You have 10 walls.",
    frames: script(
      { p1: { r: 1, c: 3 }, p2: { r: 4, c: 3 } },
      { addWall: h(4, 3), turn: 1, hold: 1200 },
      { p2: { r: 4, c: 4 }, turn: 0 },
      { addWall: h(4, 4), turn: 1, hold: 1200 },
      { p2: { r: 4, c: 5 }, turn: 0 },
      { p2: { r: 3, c: 5 }, turn: 1 },
      { p2: { r: 2, c: 5 }, turn: 0, hold: 1800 },
    ),
  },
  {
    title: 'Never fully block',
    text: "You can't trap anyone. A wall that would close the last way through isn't allowed – there must always be a path to the other side.",
    frames: script(
      { p1: { r: 1, c: 3 }, p2: { r: 5, c: 3 } },
      { addWall: h(3, 0), hold: 500 },
      { addWall: h(3, 1), hold: 500 },
      { addWall: h(3, 2), hold: 500 },
      { addWall: h(3, 3), hold: 500 },
      { addWall: h(3, 4), hold: 500 },
      { addWall: h(3, 5), hold: 900 },
      { ghost: { wall: h(3, 6), ok: false }, hold: 2600 },
    ),
  },
  {
    title: 'Jump over your opponent',
    text: "Face to face? Jump straight over your opponent. If a wall is behind them, step diagonally around them instead.",
    frames: script(
      { p1: { r: 2, c: 3 }, p2: { r: 3, c: 3 } },
      { showMoves: true, hold: 1600 },
      { p1: { r: 4, c: 3 }, hold: 1400 },
      // Same position, but now a wall is behind the opponent → step around.
      { p1: { r: 2, c: 3 }, addWall: h(4, 3, 1), hold: 1200 },
      { showMoves: true, hold: 1800 },
      { p1: { r: 3, c: 4 }, hold: 1600 },
    ),
  },
  {
    title: "That's it – your turn!",
    text: 'Every turn: move one square OR place a wall. First to the far side wins. Practise against the AI, or create a room and challenge a friend.',
    frames: script(
      { p1: { r: 0, c: 3 }, p2: { r: 6, c: 3 } },
      { p1: { r: 1, c: 3 }, turn: 1 },
      { addWall: h(2, 3, 1), turn: 0 },
      { p1: { r: 1, c: 4 }, turn: 1 },
      { p2: { r: 5, c: 3 }, turn: 0 },
      { addWall: h(5, 3), turn: 1 },
      { p2: { r: 5, c: 2 }, turn: 0 },
      { p1: { r: 2, c: 4 }, turn: 1 },
      { p2: { r: 4, c: 2 }, turn: 0 },
      { p1: { r: 3, c: 4 }, turn: 1 },
      { p2: { r: 3, c: 2 }, turn: 0 },
      { p1: { r: 4, c: 4 }, turn: 1 },
      { p2: { r: 2, c: 2 }, turn: 0 },
      { p1: { r: 5, c: 4 }, turn: 1 },
      { p2: { r: 1, c: 2 }, turn: 0 },
      { p1: { r: 6, c: 4 }, turn: 1, hold: 2200 },
    ),
  },
]);
