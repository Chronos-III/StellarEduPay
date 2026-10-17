'use strict';

const mongoose = require('mongoose');

const outboxSchema = new mongoose.Schema(
  {
    eventId:        { type: String, required: true, unique: true, index: true },
    eventType:      { type: String, required: true, index: true },
    aggregateId:    { type: String, required: true, index: true },
    aggregateType:  { type: String, required: true },
    payload:        { type: mongoose.Schema.Types.Mixed, required: true },

    processed:      { type: Boolean, default: false, index: true },
    processedAt:    { type: Date, default: null },

    retryCount:     { type: Number, default: 0 },
    lastError:      { type: String, default: null },

    deadLettered:       { type: Boolean, default: false, index: true },
    deadLetteredAt:     { type: Date, default: null },
    deadLetterReason:   { type: String, default: null },

    // #1636: W3C trace context ({ traceparent, tracestate }) of the operation
    // that wrote the event, so dispatch continues the same trace.
    traceContext:       { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  {
    timestamps: true,
  }
);

outboxSchema.pre('validate', function captureTraceContext(next) {
  if (this.isNew && !this.traceContext) {
    const traceContext = require('../tracing').injectTraceContext();
    if (traceContext) this.traceContext = traceContext;
  }
  next();
});

outboxSchema.index({ processed: 1, deadLettered: 1, createdAt: 1 });
outboxSchema.index({ eventType: 1, processed: 1 });

module.exports = mongoose.model('Outbox', outboxSchema);
