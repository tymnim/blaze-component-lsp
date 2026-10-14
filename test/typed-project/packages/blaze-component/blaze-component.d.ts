export function Helper(helperFunction: Function, _spec?: any): void;
export function Component(template: any): (Klass: typeof BlazeComponent) => typeof BlazeComponent;
export function Event(eventSelector: string): (eventFunction: Function, _spec?: any) => void;

/**
 * @template ContextData
 * @template {Record<string, any>} [Settings=Record<string, any>]
 */
export class BlazeComponent<ContextData, Settings extends Record<string, any> = Record<string, any>> {
  constructor(templateInstance: any, settings?: Settings);
  nonReactiveData(): ContextData;
  reactiveData<K extends keyof ContextData>(...fields: K[]): K extends never ? ContextData : Pick<ContextData, K>;
  static register(template: any, Klass: typeof BlazeComponent): void;
}
