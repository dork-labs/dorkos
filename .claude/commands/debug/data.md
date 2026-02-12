---
description: Inspect database schema and data directly via MCP tools
argument-hint: "[table-or-query]"
allowed-tools: Read, Grep, Glob, TodoWrite, AskUserQuestion, mcp__mcp-dev-db__health, mcp__mcp-dev-db__get_schema_overview, mcp__mcp-dev-db__get_table_details, mcp__mcp-dev-db__execute_sql_select, mcp__mcp-dev-db__explain_query, mcp__mcp-dev-db__validate_sql
---

# Database Data Debugging

Inspect and verify database state directly using MCP database tools. Use this command to:
- View schema structure and relationships
- Verify data exists after mutations
- Debug "data not showing" issues
- Test queries before implementing in DAL
- Check foreign key relationships

## Prerequisites

This command requires the MCP database server to be enabled:
1. Add `MCP_DEV_ONLY_DB_ACCESS=true` to `.env.local`
2. Restart the dev server

## Arguments

Parse `$ARGUMENTS`:
- If a table name is provided, inspect that specific table
- If a SQL query is provided, execute it
- If empty, show schema overview and prompt for action

## Phase 1: Health Check

First, verify the MCP database server is accessible:

```
mcp__mcp-dev-db__health: {}
```

If health check fails, inform user:
- Check that dev server is running (`pnpm dev`)
- Verify `MCP_DEV_ONLY_DB_ACCESS=true` is in `.env.local`
- Ensure request is from localhost

## Phase 2: Determine Action

### 2.1 If No Arguments

Get schema overview and ask what to do:

```
mcp__mcp-dev-db__get_schema_overview: {}
```

Present the tables and ask:
```
AskUserQuestion:
  question: "What would you like to inspect?"
  header: "Action"
  options:
    - label: "Inspect a specific table"
      description: "View detailed structure and sample data"
    - label: "Run a SELECT query"
      description: "Query specific data from the database"
    - label: "Verify data after mutation"
      description: "Check that recent changes were applied"
    - label: "Analyze query performance"
      description: "Use EXPLAIN to analyze a query"
```

### 2.2 If Table Name Provided

Get detailed information about that table:

```
mcp__mcp-dev-db__get_table_details: { table: "[table_name]" }
```

This returns:
- Column definitions (name, type, nullable, default)
- Indexes (name, columns, unique, primary)
- Constraints
- Sample rows (first 5)

### 2.3 If SQL Query Provided

Validate and execute the query:

```
mcp__mcp-dev-db__validate_sql: { sql: "[query]" }
mcp__mcp-dev-db__execute_sql_select: { sql: "[query]", rowLimit: 100 }
```

## Phase 3: Interactive Inspection

### 3.1 Table Inspection

After showing table details, offer follow-up actions:

```
AskUserQuestion:
  question: "What would you like to do next?"
  header: "Next Action"
  options:
    - label: "Query this table"
      description: "Run a SELECT query on this table"
    - label: "Check related tables"
      description: "Inspect tables with foreign key relationships"
    - label: "View more rows"
      description: "Fetch more sample data"
    - label: "Done"
      description: "Finished inspecting"
```

### 3.2 Query Execution

For SELECT queries:
1. Validate SQL syntax first
2. Add reasonable LIMIT if not present (default 100)
3. Execute and display results
4. Offer to refine or expand query

## Phase 4: Common Debugging Scenarios

### 4.1 "Data Not Showing" Debugging

When user suspects data should exist but isn't appearing:

1. **Identify the expected data**
   - What table should contain it?
   - What are the identifying fields (ID, name, etc.)?

2. **Query to verify existence**
   ```sql
   SELECT * FROM [table] WHERE [identifier] = '[value]' LIMIT 10
   ```

3. **Check relationships**
   - Are foreign keys correctly set?
   - Are related records present?

4. **Report findings**
   - Data exists → Issue is in application layer
   - Data missing → Issue is in write operation

### 4.2 Post-Mutation Verification

After a create/update/delete operation:

1. **Identify what changed**
   - Which table was modified?
   - What was the expected change?

2. **Query to verify**
   ```sql
   SELECT * FROM [table] WHERE [condition] ORDER BY updated_at DESC LIMIT 5
   ```

3. **Check timestamps**
   - Does `updated_at` reflect recent change?
   - Is `created_at` correct for new records?

### 4.3 Foreign Key Verification

To verify relationships are correct:

1. **Check parent record exists**
   ```sql
   SELECT * FROM [parent_table] WHERE id = '[parent_id]'
   ```

2. **Check child records link correctly**
   ```sql
   SELECT * FROM [child_table] WHERE [foreign_key] = '[parent_id]'
   ```

3. **Find orphaned records**
   ```sql
   SELECT c.* FROM [child_table] c
   LEFT JOIN [parent_table] p ON c.[foreign_key] = p.id
   WHERE p.id IS NULL
   ```

## Phase 5: Query Performance Analysis

When analyzing query performance:

```
mcp__mcp-dev-db__explain_query: { sql: "[SELECT query]" }
```

Interpret the EXPLAIN output:
- **Seq Scan** → Consider adding an index
- **High cost** → Query may be slow at scale
- **Nested Loop** → Check for N+1 patterns
- **Index Scan** → Good, using index efficiently

## Output Format

### Schema Overview

```markdown
## Database Schema Overview

| Table | Rows | Columns | Primary Key |
|-------|------|---------|-------------|
| users | 150 | 8 | id |
| posts | 1,234 | 12 | id |
...

### Foreign Key Relationships
- posts.author_id → users.id
- comments.post_id → posts.id
...
```

### Table Details

```markdown
## Table: [table_name]

**Row Count**: [count]

### Columns
| Name | Type | Nullable | Default |
|------|------|----------|---------|
...

### Indexes
| Name | Columns | Unique | Primary |
|------|---------|--------|---------|
...

### Sample Data
[First 5 rows as table]
```

### Query Results

```markdown
## Query Results

**Query**: `[sql]`
**Rows Returned**: [count]

[Results as table or JSON]
```

## Security Notes

- This command is **development-only**
- Cannot execute DDL (CREATE, DROP, ALTER, TRUNCATE)
- Cannot execute GRANT, REVOKE, or other privilege commands
- Mutations require explicit reason (use `/debug:api` for mutation debugging)
- All queries are logged for audit

## Quick Reference

### Common Queries

```sql
-- Count rows in table
SELECT COUNT(*) FROM [table]

-- Recent records
SELECT * FROM [table] ORDER BY created_at DESC LIMIT 10

-- Find by ID
SELECT * FROM [table] WHERE id = '[id]'

-- Check relationships
SELECT p.*, u.email as author_email
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.id = '[post_id]'

-- Find duplicates
SELECT [column], COUNT(*)
FROM [table]
GROUP BY [column]
HAVING COUNT(*) > 1
```

## Edge Cases

- **Large tables**: Always use LIMIT to avoid timeout
- **Binary data**: May not display correctly, check column types
- **NULL values**: Distinguish between NULL and empty string
- **Timestamps**: Displayed in UTC, convert if needed
- **Decimal precision**: May show scientific notation for very large/small numbers
