export const Template: Record<string, any> & {
  // Use Function (not a call signature) so the argument keeps its own JSDoc types
  registerHelper(name: string, fn: Function): void;
};

export const Blaze: {
  registerHelper(name: string, fn: Function): void;
};
