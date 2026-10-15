
#!/bin/bash
set -euo pipefail

echo "Creating Jungle Gaming SQS queues..."

# Create dead-letter queue
DLQ_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true \
  --query QueueUrl \
  --output text)

# Retrieve DLQ ARN
DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)

# Create main FIFO queue
MAIN_URL=$(awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl \
  --output text)

# Configure redrive policy
REDRIVE_POLICY=$(printf \
  '{"deadLetterTargetArn":"%s","maxReceiveCount":3}' \
  "$DLQ_ARN")

# Build AWS CLI attributes JSON safely
ATTRIBUTES_JSON=$(printf \
  '{"RedrivePolicy":%s}' \
  "$(printf '%s' "$REDRIVE_POLICY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")

awslocal sqs set-queue-attributes \
  --queue-url "$MAIN_URL" \
  --attributes "$ATTRIBUTES_JSON"

echo "Jungle Gaming SQS queues initialized successfully."
