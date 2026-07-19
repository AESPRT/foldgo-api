declare const GetEvent: {
    readonly body: {
        readonly properties: {
            readonly rule: {
                readonly type: "string";
            };
            readonly rule_action: {
                readonly type: "string";
            };
        };
        readonly type: "object";
        readonly required: readonly ["rule"];
        readonly $schema: "http://json-schema.org/draft-04/schema#";
    };
};
declare const GetRulesId: {
    readonly metadata: {
        readonly allOf: readonly [{
            readonly type: "object";
            readonly properties: {
                readonly id: {
                    readonly type: "string";
                    readonly $schema: "http://json-schema.org/draft-04/schema#";
                };
            };
            readonly required: readonly ["id"];
        }];
    };
};
declare const PostEvents: {
    readonly body: {
        readonly properties: {
            readonly rule: {
                readonly type: "string";
            };
            readonly rule_action: {
                readonly type: "string";
            };
        };
        readonly type: "object";
        readonly required: readonly ["rule"];
        readonly $schema: "http://json-schema.org/draft-04/schema#";
    };
};
declare const PostPutEvent: {
    readonly body: {
        readonly properties: {
            readonly event: {
                readonly type: "string";
            };
        };
        readonly type: "object";
        readonly required: readonly ["event"];
        readonly $schema: "http://json-schema.org/draft-04/schema#";
    };
};
declare const PostWorkflow: {
    readonly body: {
        readonly properties: {
            readonly name: {
                readonly type: "string";
            };
            readonly handle: {
                readonly type: "string";
            };
            readonly workflow_definition: {
                readonly type: "string";
                readonly description: "Base64 encoded version of workflow YAML definition";
            };
        };
        readonly type: "object";
        readonly required: readonly ["name", "handle", "workflow_definition"];
        readonly $schema: "http://json-schema.org/draft-04/schema#";
    };
};
export { GetEvent, GetRulesId, PostEvents, PostPutEvent, PostWorkflow };
