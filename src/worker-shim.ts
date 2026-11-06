// tfjs の setTimeoutCustom は `!window` を評価するため、Worker では ReferenceError になる。
// window を undefined として定義しておくと、通常の setTimeout の経路に入る。
(globalThis as unknown as { window: undefined }).window = undefined;
export {};
