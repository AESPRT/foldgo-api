import type { FromSchema } from 'json-schema-to-ts';
import * as schemas from './schemas';
export type GetEventBodyParam = FromSchema<typeof schemas.GetEvent.body>;
export type GetRulesIdMetadataParam = FromSchema<typeof schemas.GetRulesId.metadata>;
export type PostEventsBodyParam = FromSchema<typeof schemas.PostEvents.body>;
export type PostPutEventBodyParam = FromSchema<typeof schemas.PostPutEvent.body>;
export type PostWorkflowBodyParam = FromSchema<typeof schemas.PostWorkflow.body>;
