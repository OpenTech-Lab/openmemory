use super::*;

impl McpServer {
    pub(super) async fn forecast_list(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let profiles = forecasts::list(&self.db).await?;
        let text = if profiles.is_empty() {
            "No forecast profiles configured. Use forecast_create to add one.".to_string()
        } else {
            serde_json::to_string_pretty(&profiles)?
        };
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn forecast_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let input: forecasts::ForecastInput =
            serde_json::from_value(args.clone()).context("invalid forecast profile fields")?;
        input.validate().map_err(anyhow::Error::msg)?;
        let profile = forecasts::create(&self.db, &input).await?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Created forecast profile '{}' [id: {}].", profile.name, profile.id
        )}]}))
    }

    pub(super) async fn forecast_update(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id = Uuid::parse_str(args["id"].as_str().context("missing id")?)
            .context("invalid forecast profile id")?;
        let input: forecasts::ForecastInput =
            serde_json::from_value(args.clone()).context("invalid forecast profile fields")?;
        input.validate().map_err(anyhow::Error::msg)?;
        let profile = forecasts::update(&self.db, id, &input)
            .await?
            .context("forecast profile not found")?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Updated forecast profile '{}' [id: {}].", profile.name, profile.id
        )}]}))
    }

    pub(super) async fn forecast_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let id = Uuid::parse_str(args["id"].as_str().context("missing id")?)
            .context("invalid forecast profile id")?;
        let deleted = sqlx::query("DELETE FROM forecast_profiles WHERE id = $1 RETURNING id")
            .bind(id)
            .fetch_optional(&self.db)
            .await?;
        deleted.context("forecast profile not found")?;
        Ok(
            json!({"content": [{"type": "text", "text": format!("Deleted forecast profile {id}.")}]}),
        )
    }

    pub(super) async fn design_budget_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let forecasts = design_budgets::list(&self.db, design_id).await?;
        let text = if forecasts.is_empty() {
            "No budget forecasts saved for this design.".into()
        } else {
            serde_json::to_string_pretty(&forecasts)?
        };
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn design_budget_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let mut input: design_budgets::BudgetInput =
            serde_json::from_value(args.clone()).context("invalid budget forecast fields")?;
        input.created_by = Some("agent".into());
        input.validate().map_err(anyhow::Error::msg)?;
        let forecast = design_budgets::create(&self.db, design_id, &input).await?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Created design budget '{}' [id: {}], estimated at {:.2} {} per month.",
            forecast.name, forecast.id, forecast.monthly_total_cents as f64 / 100.0, forecast.currency
        )}]}))
    }

    pub(super) async fn design_budget_update(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let budget_id = Uuid::parse_str(args["budget_id"].as_str().context("missing budget_id")?)
            .context("invalid budget_id")?;
        let input: design_budgets::BudgetInput =
            serde_json::from_value(args.clone()).context("invalid budget forecast fields")?;
        input.validate().map_err(anyhow::Error::msg)?;
        let forecast = design_budgets::update(&self.db, design_id, budget_id, &input)
            .await?
            .context("budget forecast not found")?;
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Updated design budget '{}' [id: {}].", forecast.name, forecast.id
        )}]}))
    }

    pub(super) async fn design_budget_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let design_id = Uuid::parse_str(args["design_id"].as_str().context("missing design_id")?)
            .context("invalid design_id")?;
        let budget_id = Uuid::parse_str(args["budget_id"].as_str().context("missing budget_id")?)
            .context("invalid budget_id")?;
        let deleted = sqlx::query(
            "DELETE FROM design_budget_forecasts WHERE id = $1 AND design_id = $2 RETURNING id",
        )
        .bind(budget_id)
        .bind(design_id)
        .fetch_optional(&self.db)
        .await?;
        deleted.context("budget forecast not found")?;
        Ok(
            json!({"content": [{"type": "text", "text": format!("Deleted design budget {budget_id}.")}]}),
        )
    }

    pub(super) async fn project_list(
        &mut self,
        _args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let rows = sqlx::query(
            r#"SELECT p.id, p.name, p.path, p.description, p.node_count, p.edge_count,
                      COUNT(t.id) AS task_count
               FROM project_graphs p
               LEFT JOIN project_tasks t ON t.project_id = p.id
               GROUP BY p.id ORDER BY p.created_at DESC"#,
        )
        .fetch_all(&self.db)
        .await
        .context("failed to list projects")?;

        if rows.is_empty() {
            return Ok(
                json!({"content": [{"type": "text", "text": "No projects yet. Use project_create to add one."}]}),
            );
        }

        let mut text = format!("Projects ({}):\n\n", rows.len());
        for r in &rows {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let name: String = r.try_get("name").unwrap_or_default();
            let path: Option<String> = r.try_get("path").unwrap_or(None);
            let task_count: i64 = r.try_get("task_count").unwrap_or(0);
            let node_count: i32 = r.try_get("node_count").unwrap_or(0);
            text.push_str(&format!(
                "• {} [id: {}]  tasks: {}  nodes: {}{}\n",
                name,
                id,
                task_count,
                node_count,
                path.as_deref()
                    .map(|p| format!("\n  path: {}", p))
                    .unwrap_or_default(),
            ));
        }

        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn project_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let name = args["name"].as_str().context("missing name")?.to_string();
        let path_opt = args["path"].as_str().map(|s| s.to_string());
        let description = args["description"].as_str().map(|s| s.to_string());

        if let Some(ref path) = path_opt {
            let (data, hash, size, canonical) = indexer::index_project(path).await?;
            let (node_count, edge_count) = project_graphs::count_nodes_edges(&data);
            sqlx::query(
                r#"INSERT INTO project_graphs (name, path, canonical_path, description, node_count, edge_count,
                   graph_data, graph_hash, graph_file_size, imported_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                   ON CONFLICT (canonical_path) DO UPDATE SET
                     name = EXCLUDED.name, description = COALESCE(EXCLUDED.description, project_graphs.description),
                     node_count = EXCLUDED.node_count, edge_count = EXCLUDED.edge_count,
                     graph_data = EXCLUDED.graph_data, graph_hash = EXCLUDED.graph_hash,
                     graph_file_size = EXCLUDED.graph_file_size, imported_at = EXCLUDED.imported_at,
                     updated_at = NOW()"#,
            )
            .bind(&name).bind(path).bind(&canonical).bind(&description)
            .bind(node_count).bind(edge_count).bind(&data)
            .bind(&hash).bind(size as i64)
            .execute(&self.db).await.context("failed to create project")?;
            Ok(
                json!({"content": [{"type": "text", "text": format!("Created project '{}' with graph ({} nodes, {} edges).", name, node_count, edge_count)}]}),
            )
        } else {
            sqlx::query(
                "INSERT INTO project_graphs (name, path, canonical_path, description, graph_data) \
                 VALUES ($1, NULL, NULL, $2, '{}'::jsonb)",
            )
            .bind(&name)
            .bind(&description)
            .execute(&self.db)
            .await
            .context("failed to create project")?;
            Ok(
                json!({"content": [{"type": "text", "text": format!("Created project '{}' (no graph path — task management only).", name)}]}),
            )
        }
    }

    pub(super) async fn project_task_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let status_filter = args["status"].as_str();
        let limit: i64 = args["limit"].as_i64().unwrap_or(50).min(200);
        let offset: i64 = args["offset"].as_i64().unwrap_or(0).max(0);

        let tasks = if let Some(status) = status_filter {
            sqlx::query(
                "SELECT id, title, status, priority, assigned_to, created_by, created_at, parent_id, start_date, due_date \
                 FROM project_tasks WHERE project_id = $1 AND status = $2 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $3 OFFSET $4"
            )
            .bind(project_id).bind(status).bind(limit).bind(offset)
            .fetch_all(&self.db).await
        } else {
            sqlx::query(
                "SELECT id, title, status, priority, assigned_to, created_by, created_at, parent_id, start_date, due_date \
                 FROM project_tasks WHERE project_id = $1 \
                 ORDER BY sort_order ASC, created_at DESC LIMIT $2 OFFSET $3"
            )
            .bind(project_id).bind(limit).bind(offset)
            .fetch_all(&self.db).await
        }.context("failed to list tasks")?;

        if tasks.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No tasks found."}]}));
        }

        let mut text = format!("Tasks ({}):\n\n", tasks.len());
        for t in &tasks {
            let id: Uuid = t.try_get("id").unwrap_or(Uuid::nil());
            let title: String = t.try_get("title").unwrap_or_default();
            let status: String = t.try_get("status").unwrap_or_default();
            let priority: String = t.try_get("priority").unwrap_or_default();
            let assigned: Option<String> = t.try_get("assigned_to").unwrap_or(None);
            let parent_id: Option<Uuid> = t.try_get("parent_id").unwrap_or(None);
            let due_date: Option<chrono::NaiveDate> = t.try_get("due_date").unwrap_or(None);
            text.push_str(&format!(
                "• [{}] {} ({}){}{}{}\n  id: {}\n",
                status,
                title,
                priority,
                assigned
                    .as_deref()
                    .map(|a| format!(" → {}", a))
                    .unwrap_or_default(),
                due_date.map(|d| format!(" due: {}", d)).unwrap_or_default(),
                parent_id
                    .map(|p| format!(" parent: {}", p))
                    .unwrap_or_default(),
                id
            ));
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn project_task_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());
        let status = args["status"].as_str().unwrap_or("todo");
        let priority = args["priority"].as_str().unwrap_or("medium");
        let assigned_to = args["assigned_to"].as_str().map(|s| s.to_string());
        let parent_id: Option<Uuid> = args["parent_id"]
            .as_str()
            .map(|s| s.parse::<Uuid>())
            .transpose()
            .context("invalid parent_id UUID")?;
        let start_date: Option<chrono::NaiveDate> = args["start_date"]
            .as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d"))
            .transpose()
            .context("invalid start_date, expected YYYY-MM-DD")?;
        let due_date: Option<chrono::NaiveDate> = args["due_date"]
            .as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d"))
            .transpose()
            .context("invalid due_date, expected YYYY-MM-DD")?;

        if let Some(pid) = parent_id {
            let parent_project: Option<Uuid> =
                sqlx::query_scalar("SELECT project_id FROM project_tasks WHERE id = $1")
                    .bind(pid)
                    .fetch_optional(&self.db)
                    .await
                    .unwrap_or(None);
            if parent_project != Some(project_id) {
                anyhow::bail!("parent_id must reference a task in the same project");
            }
        }

        let row = sqlx::query(
            "INSERT INTO project_tasks (project_id, title, description, status, priority, assigned_to, created_by, parent_id, start_date, due_date) \
             VALUES ($1, $2, $3, $4, $5, $6, 'agent', $7, $8, $9) RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&description)
        .bind(status).bind(priority).bind(&assigned_to)
        .bind(parent_id).bind(start_date).bind(due_date)
        .fetch_one(&self.db).await.context("failed to create task")?;

        let id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
        Ok(
            json!({"content": [{"type": "text", "text": format!("Created task '{}' [{}] id: {}", title, status, id)}]}),
        )
    }

    pub(super) async fn project_task_update(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"]
            .as_str()
            .context("missing task_id")?
            .parse()
            .context("invalid task_id UUID")?;

        let title = args["title"].as_str().map(|s| s.to_string());
        let description = args["description"].as_str().map(|s| s.to_string());
        let status = args["status"].as_str().map(|s| s.to_string());
        let priority = args["priority"].as_str().map(|s| s.to_string());
        let assigned_to = args["assigned_to"].as_str().map(|s| s.to_string());

        let parent_id_set = args.get("parent_id").is_some();
        let parent_id_value: Option<Uuid> = args["parent_id"]
            .as_str()
            .map(|s| s.parse::<Uuid>())
            .transpose()
            .context("invalid parent_id UUID")?;
        let start_date_set = args.get("start_date").is_some();
        let start_date_value: Option<chrono::NaiveDate> = args["start_date"]
            .as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d"))
            .transpose()
            .context("invalid start_date, expected YYYY-MM-DD")?;
        let due_date_set = args.get("due_date").is_some();
        let due_date_value: Option<chrono::NaiveDate> = args["due_date"]
            .as_str()
            .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d"))
            .transpose()
            .context("invalid due_date, expected YYYY-MM-DD")?;

        if let Some(new_parent_id) = parent_id_value {
            let parent_project: Option<Uuid> =
                sqlx::query_scalar("SELECT project_id FROM project_tasks WHERE id = $1")
                    .bind(new_parent_id)
                    .fetch_optional(&self.db)
                    .await
                    .unwrap_or(None);
            if parent_project != Some(project_id) {
                anyhow::bail!("parent_id must reference a task in the same project");
            }
            if would_create_cycle(&self.db, task_id, new_parent_id)
                .await
                .context("cycle check failed")?
            {
                anyhow::bail!("parent_id would create a cycle");
            }
        }

        let result = sqlx::query(
            "UPDATE project_tasks SET \
             title = COALESCE($1, title), \
             description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END, \
             status = COALESCE($3, status), \
             priority = COALESCE($4, priority), \
             assigned_to = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE assigned_to END, \
             parent_id = CASE WHEN $8 THEN $9 ELSE parent_id END, \
             start_date = CASE WHEN $10 THEN $11 ELSE start_date END, \
             due_date = CASE WHEN $12 THEN $13 ELSE due_date END, \
             updated_at = NOW() \
             WHERE id = $6 AND project_id = $7 RETURNING id",
        )
        .bind(&title)
        .bind(&description)
        .bind(&status)
        .bind(&priority)
        .bind(&assigned_to)
        .bind(task_id)
        .bind(project_id)
        .bind(parent_id_set)
        .bind(parent_id_value)
        .bind(start_date_set)
        .bind(start_date_value)
        .bind(due_date_set)
        .bind(due_date_value)
        .fetch_optional(&self.db)
        .await
        .context("failed to update task")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Task not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Updated task {}.", task_id)}]}))
    }

    pub(super) async fn project_task_note_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"]
            .as_str()
            .context("missing task_id")?
            .parse()
            .context("invalid task_id UUID")?;
        let limit: i64 = args["limit"].as_i64().unwrap_or(100).clamp(1, 200);

        let task_exists = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM project_tasks WHERE id = $1 AND project_id = $2",
        )
        .bind(task_id)
        .bind(project_id)
        .fetch_optional(&self.db)
        .await
        .context("failed to find task")?;
        if task_exists.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Task not found."}]}));
        }

        let notes = sqlx::query(
            "SELECT n.id, n.content, n.author, n.created_at, n.note_type, n.decision_options, n.decision_status, n.decision_resolved_by, \
                    n.decision_selection_mode, \
                    COALESCE((SELECT json_agg(json_build_object('options', a.selected_options, 'reply', a.reply, \
                        'answered_by', a.answered_by, 'answered_at', a.answered_at) ORDER BY a.answered_at ASC) \
                        FROM project_task_decision_answers a WHERE a.note_id = n.id), '[]'::json) AS decision_answers \
             FROM project_task_notes n WHERE n.task_id = $1 \
             ORDER BY n.created_at ASC, n.id ASC LIMIT $2",
        )
        .bind(task_id)
        .bind(limit)
        .fetch_all(&self.db)
        .await
        .context("failed to list task implementation notes")?;

        if notes.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No implementation notes found."}]}));
        }

        let mut text = format!("Implementation notes ({}):\n\n", notes.len());
        for note in &notes {
            let id: Uuid = note.try_get("id").context("invalid note id")?;
            let content: String = note.try_get("content").context("invalid note content")?;
            let author: String = note.try_get("author").context("invalid note author")?;
            let created_at: DateTime<Utc> = note.try_get("created_at").context("invalid note timestamp")?;
            text.push_str(&format!(
                "• [{}] {}\n  {}\n  id: {}\n\n",
                author,
                created_at.format("%Y-%m-%d %H:%M UTC"),
                content,
                id
            ));
            let note_type: String = note.try_get("note_type").unwrap_or_else(|_| "message".to_string());
            if note_type == "decision" {
                let options: serde_json::Value = note.try_get("decision_options").unwrap_or_else(|_| json!([]));
                let selection_mode: String = note.try_get("decision_selection_mode").unwrap_or_else(|_| "multiple".to_string());
                let status: String = note.try_get("decision_status").unwrap_or_else(|_| "open".to_string());
                let answers: serde_json::Value = note.try_get("decision_answers").unwrap_or_else(|_| json!([]));
                let latest = answers.as_array().and_then(|values| values.last());
                let latest_summary = latest
                    .and_then(|entry| entry.get("options"))
                    .map(|value| format!(" | latest: {value}"))
                    .unwrap_or_default();
                let latest_reply = latest
                    .and_then(|entry| entry.get("reply"))
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.is_empty())
                    .map(|value| format!(" | reply: {value}"))
                    .unwrap_or_default();
                let history_count = answers.as_array().map(|values| values.len()).unwrap_or(0);
                text.push_str(&format!(
                    "  decision: {} | selection: {} | choices: {}{}{} | answers so far: {}\n\n",
                    status,
                    selection_mode,
                    options,
                    latest_summary,
                    latest_reply,
                    history_count
                ));
            }
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn project_task_note_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"]
            .as_str()
            .context("missing task_id")?
            .parse()
            .context("invalid task_id UUID")?;
        let content = args["content"]
            .as_str()
            .context("missing content")?
            .trim();
        if content.is_empty() {
            anyhow::bail!("content must be non-empty");
        }
        if content.chars().count() > 20_000 {
            anyhow::bail!("content must be 20,000 characters or fewer");
        }

        let note_type = args["note_type"].as_str().unwrap_or("message").trim();
        if !matches!(note_type, "message" | "decision") {
            anyhow::bail!("note_type must be message or decision");
        }
        let options: Vec<String> = args["decision_options"]
            .as_array()
            .map(|values| values.iter().filter_map(|value| value.as_str().map(str::trim)).filter(|value| !value.is_empty()).map(ToOwned::to_owned).collect())
            .unwrap_or_default();
        let selection_mode = args["decision_selection_mode"].as_str().unwrap_or("single").trim();
        if !matches!(selection_mode, "single" | "multiple") {
            anyhow::bail!("decision_selection_mode must be single or multiple");
        }
        if note_type != "decision" && selection_mode != "single" {
            anyhow::bail!("decision_selection_mode is only valid for decision notes");
        }
        if note_type == "decision" && options.len() > 6 {
            anyhow::bail!("decisions may have up to six choices");
        }
        if note_type == "message" && !options.is_empty() {
            anyhow::bail!("decision_options are only valid for decision notes");
        }
        if options.iter().any(|option| option.chars().count() > 120)
            || options.iter().enumerate().any(|(index, option)| options[..index].iter().any(|previous| previous.eq_ignore_ascii_case(option)))
        {
            anyhow::bail!("decision options must be unique and 120 characters or fewer");
        }

        let task_exists = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM project_tasks WHERE id = $1 AND project_id = $2",
        )
        .bind(task_id)
        .bind(project_id)
        .fetch_optional(&self.db)
        .await
        .context("failed to find task")?;
        if task_exists.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Task not found."}]}));
        }

        let row = sqlx::query(
            "INSERT INTO project_task_notes (task_id, content, author, note_type, decision_options, decision_selection_mode) \
             VALUES ($1, $2, 'agent', $3, $4, $5) RETURNING id",
        )
        .bind(task_id)
        .bind(content)
        .bind(note_type)
        .bind(json!(options))
        .bind(selection_mode)
        .fetch_one(&self.db)
        .await
        .context("failed to create task implementation note")?;
        let id: Uuid = row.try_get("id").context("invalid note id")?;

        Ok(json!({"content": [{"type": "text", "text": format!("Added implementation note to task {} [id: {}].", task_id, id)}]}))
    }

    pub(super) async fn project_task_note_decide(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"]
            .as_str()
            .context("missing task_id")?
            .parse()
            .context("invalid task_id UUID")?;
        let note_id: Uuid = args["note_id"]
            .as_str()
            .context("missing note_id")?
            .parse()
            .context("invalid note_id UUID")?;
        let raw_options: Vec<String> = args["options"]
            .as_array()
            .map(|values| values
            .iter()
            .map(|value| value.as_str().map(str::trim).map(ToOwned::to_owned).context("options must be strings"))
            .collect::<Result<Vec<String>>>())
            .transpose()?
            .unwrap_or_default();
        let reply = args["reply"].as_str().map(str::trim).unwrap_or("").to_string();
        if reply.chars().count() > 20_000 {
            anyhow::bail!("reply must be 20,000 characters or fewer");
        }
        if raw_options.is_empty() && reply.is_empty() {
            anyhow::bail!("select at least one choice or provide a reply");
        }
        if raw_options.len() > 6 {
            anyhow::bail!("options must contain at most 6 choices");
        }
        let mut options: Vec<String> = Vec::with_capacity(raw_options.len());
        for option in raw_options {
            if option.is_empty() || option.chars().count() > 120 {
                anyhow::bail!("each option must be between 1 and 120 characters");
            }
            if options.iter().any(|existing: &String| existing.eq_ignore_ascii_case(&option)) {
                anyhow::bail!("options must not contain duplicates");
            }
            options.push(option);
        }

        // No `decision_status = 'open'` filter — re-answering an already-resolved decision is
        // allowed.
        let decision = sqlx::query(
            "SELECT n.decision_options, n.decision_selection_mode FROM project_task_notes n \
             JOIN project_tasks t ON t.id = n.task_id \
             WHERE n.id = $1 AND n.task_id = $2 AND t.project_id = $3 \
               AND n.note_type = 'decision'",
        )
        .bind(note_id)
        .bind(task_id)
        .bind(project_id)
        .fetch_optional(&self.db)
        .await?
        .context("decision not found")?;
        let decision_options: serde_json::Value = decision.try_get("decision_options").context("invalid decision options")?;
        let selection_mode: String = decision.try_get("decision_selection_mode").unwrap_or_else(|_| "multiple".to_string());
        if selection_mode == "single" && options.len() > 1 {
            anyhow::bail!("this decision allows only one selected choice");
        }
        let valid_choices: Vec<&str> = decision_options
            .as_array()
            .map(|values| values.iter().filter_map(|value| value.as_str()).collect())
            .unwrap_or_default();
        if options.iter().any(|option| !valid_choices.contains(&option.as_str())) {
            anyhow::bail!("options must each be one of the decision choices");
        }

        let actor = args["author"].as_str().unwrap_or("agent");
        if !matches!(actor, "human" | "agent") {
            anyhow::bail!("author must be human or agent");
        }

        let mut tx = self.db.begin().await.context("failed to start transaction")?;
        sqlx::query(
            "INSERT INTO project_task_decision_answers (note_id, selected_options, reply, answered_by) VALUES ($1, $2, $3, $4)",
        )
        .bind(note_id)
        .bind(json!(options))
        .bind(if reply.is_empty() { None } else { Some(reply.as_str()) })
        .bind(actor)
        .execute(&mut *tx)
        .await
        .context("failed to record decision answer")?;
        sqlx::query(
            "UPDATE project_task_notes SET decision_status = 'resolved', decision_resolved_by = $1, decision_resolved_at = NOW() \
             WHERE id = $2 AND task_id = $3 AND note_type = 'decision'",
        )
        .bind(actor)
        .bind(note_id)
        .bind(task_id)
        .execute(&mut *tx)
        .await
        .context("failed to update decision status")?;
        tx.commit().await.context("failed to commit decision answer")?;

        let summary = [
            (!options.is_empty()).then(|| options.join(", ")),
            (!reply.is_empty()).then(|| reply.clone()),
        ].into_iter().flatten().collect::<Vec<_>>().join(" · ");
        Ok(json!({"content": [{"type": "text", "text": format!("Recorded answer for decision {}: {}.", note_id, summary)}]}))
    }

    pub(super) async fn project_task_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let task_id: Uuid = args["task_id"]
            .as_str()
            .context("missing task_id")?
            .parse()
            .context("invalid task_id UUID")?;

        let result =
            sqlx::query("DELETE FROM project_tasks WHERE id = $1 AND project_id = $2 RETURNING id")
                .bind(task_id)
                .bind(project_id)
                .fetch_optional(&self.db)
                .await
                .context("failed to delete task")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Task not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Deleted task {}.", task_id)}]}))
    }

    pub(super) async fn lesson_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?.to_string();
        let rule = args["rule"].as_str().context("missing rule")?.to_string();
        let context_val = args["context"].as_str().map(|s| s.to_string());
        let category = args["category"].as_str().unwrap_or("correction");
        let severity = args["severity"].as_str().unwrap_or("medium");
        let tags: Vec<String> = normalize_lesson_tags(
            &(args["tags"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default()),
        );

        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM project_lessons WHERE project_id = $1 AND status = 'active' AND lower(trim(title)) = lower(trim($2))"
        )
        .bind(project_id).bind(&title)
        .fetch_optional(&self.db).await.unwrap_or(None);

        if let Some(lesson_id) = existing {
            let row = sqlx::query(
                "UPDATE project_lessons SET occurrences = occurrences + 1, last_seen_at = NOW(), updated_at = NOW() \
                 WHERE id = $1 RETURNING occurrences"
            )
            .bind(lesson_id)
            .fetch_one(&self.db).await.context("failed to bump lesson occurrences")?;
            let occurrences: i32 = row.try_get("occurrences").unwrap_or(1);
            return Ok(json!({"content": [{"type": "text", "text": format!(
                "Lesson '{}' already recorded — bumped occurrences to {}. id: {}", title, occurrences, lesson_id
            )}]}));
        }

        let row = sqlx::query(
            "INSERT INTO project_lessons (project_id, title, context, rule, category, severity, tags) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&context_val).bind(&rule)
        .bind(category).bind(severity).bind(&tags)
        .fetch_one(&self.db).await.context("failed to create lesson")?;

        let id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
        Ok(
            json!({"content": [{"type": "text", "text": format!("Created lesson '{}' [{}] id: {}", title, category, id)}]}),
        )
    }

    pub(super) async fn lesson_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Option<Uuid> = args["project_id"]
            .as_str()
            .map(|s| s.parse::<Uuid>())
            .transpose()
            .context("invalid project_id UUID")?;
        let query = args["query"].as_str();
        let category = args["category"].as_str();
        let tags: Vec<String> = normalize_lesson_tags(
            &(args["tags"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default()),
        );
        let status = args["status"].as_str().unwrap_or("active");
        let limit: i64 = args["limit"].as_i64().unwrap_or(50).min(200);
        let offset: i64 = args["offset"].as_i64().unwrap_or(0).max(0);

        let cols = "id, project_id, title, context, rule, category, severity, status, tags, occurrences, last_seen_at";

        let rows = match (project_id, query) {
            (Some(pid), Some(q)) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE project_id = $1 AND status = $2 \
                   AND ($3::text IS NULL OR category = $3) \
                   AND (cardinality($4::text[]) = 0 OR tags && $4) \
                   AND to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule) @@ plainto_tsquery('english', $5) \
                 ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule), plainto_tsquery('english', $5)) DESC \
                 LIMIT $6 OFFSET $7"
            ))
            .bind(pid).bind(status).bind(category).bind(&tags).bind(q).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
            (Some(pid), None) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE project_id = $1 AND status = $2 \
                   AND ($3::text IS NULL OR category = $3) \
                   AND (cardinality($4::text[]) = 0 OR tags && $4) \
                 ORDER BY severity DESC, last_seen_at DESC \
                 LIMIT $5 OFFSET $6"
            ))
            .bind(pid).bind(status).bind(category).bind(&tags).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
            (None, Some(q)) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE status = $1 \
                   AND ($2::text IS NULL OR category = $2) \
                   AND (cardinality($3::text[]) = 0 OR tags && $3) \
                   AND to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule) @@ plainto_tsquery('english', $4) \
                 ORDER BY ts_rank(to_tsvector('english', title || ' ' || coalesce(context,'') || ' ' || rule), plainto_tsquery('english', $4)) DESC \
                 LIMIT $5 OFFSET $6"
            ))
            .bind(status).bind(category).bind(&tags).bind(q).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
            (None, None) => sqlx::query(&format!(
                "SELECT {cols} FROM project_lessons \
                 WHERE status = $1 \
                   AND ($2::text IS NULL OR category = $2) \
                   AND (cardinality($3::text[]) = 0 OR tags && $3) \
                 ORDER BY severity DESC, last_seen_at DESC \
                 LIMIT $4 OFFSET $5"
            ))
            .bind(status).bind(category).bind(&tags).bind(limit).bind(offset)
            .fetch_all(&self.db).await,
        }.context("failed to list lessons")?;

        if rows.is_empty() {
            return Ok(json!({"content": [{"type": "text", "text": "No lessons found."}]}));
        }

        let mut text = format!("Lessons ({}):\n\n", rows.len());
        for r in &rows {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let title: String = r.try_get("title").unwrap_or_default();
            let rule: String = r.try_get("rule").unwrap_or_default();
            let context_val: Option<String> = r.try_get("context").unwrap_or(None);
            let category: String = r.try_get("category").unwrap_or_default();
            let severity: String = r.try_get("severity").unwrap_or_default();
            let occurrences: i32 = r.try_get("occurrences").unwrap_or(1);
            text.push_str(&format!(
                "• [{}/{}] {} (x{})\n  rule: {}{}\n  id: {}\n",
                category,
                severity,
                title,
                occurrences,
                rule,
                context_val
                    .map(|c| format!("\n  context: {}", c))
                    .unwrap_or_default(),
                id
            ));
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn lesson_update(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let lesson_id: Uuid = args["lesson_id"]
            .as_str()
            .context("missing lesson_id")?
            .parse()
            .context("invalid lesson_id UUID")?;

        let title = args["title"].as_str().map(|s| s.to_string());
        let context_set = args.get("context").is_some();
        let context_value = args["context"].as_str().map(|s| s.to_string());
        let rule = args["rule"].as_str().map(|s| s.to_string());
        let category = args["category"].as_str().map(|s| s.to_string());
        let severity = args["severity"].as_str().map(|s| s.to_string());
        let status = args["status"].as_str().map(|s| s.to_string());
        let tags: Option<Vec<String>> = args["tags"].as_array().map(|arr| {
            normalize_lesson_tags(
                &arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>(),
            )
        });

        let result = sqlx::query(
            "UPDATE project_lessons SET \
             title = COALESCE($1, title), \
             context = CASE WHEN $2 THEN $3 ELSE context END, \
             rule = COALESCE($4, rule), \
             category = COALESCE($5, category), \
             severity = COALESCE($6, severity), \
             status = COALESCE($7, status), \
             tags = COALESCE($8, tags), \
             updated_at = NOW() \
             WHERE id = $9 AND project_id = $10 RETURNING id",
        )
        .bind(&title)
        .bind(context_set)
        .bind(&context_value)
        .bind(&rule)
        .bind(&category)
        .bind(&severity)
        .bind(&status)
        .bind(&tags)
        .bind(lesson_id)
        .bind(project_id)
        .fetch_optional(&self.db)
        .await
        .context("failed to update lesson")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Lesson not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Updated lesson {}.", lesson_id)}]}))
    }

    pub(super) async fn lesson_delete(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let lesson_id: Uuid = args["lesson_id"]
            .as_str()
            .context("missing lesson_id")?
            .parse()
            .context("invalid lesson_id UUID")?;

        let result = sqlx::query(
            "DELETE FROM project_lessons WHERE id = $1 AND project_id = $2 RETURNING id",
        )
        .bind(lesson_id)
        .bind(project_id)
        .fetch_optional(&self.db)
        .await
        .context("failed to delete lesson")?;

        if result.is_none() {
            return Ok(json!({"content": [{"type": "text", "text": "Lesson not found."}]}));
        }
        Ok(json!({"content": [{"type": "text", "text": format!("Deleted lesson {}.", lesson_id)}]}))
    }

    pub(super) async fn routine_check(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id_opt = args["project_id"]
            .as_str()
            .map(|s| s.parse::<Uuid>())
            .transpose()
            .context("invalid project_id UUID")?;
        let dry_run = args["dry_run"].as_bool().unwrap_or(false);

        let all = if let Some(pid) = project_id_opt {
            sqlx::query(
                r#"SELECT id, project_id, title, description, frequency, priority, assigned_to, last_task_date
                   FROM project_routines WHERE project_id = $1 AND enabled = TRUE"#
            ).bind(pid).fetch_all(&self.db).await
        } else {
            sqlx::query(
                r#"SELECT id, project_id, title, description, frequency, priority, assigned_to, last_task_date
                   FROM project_routines WHERE enabled = TRUE"#
            ).fetch_all(&self.db).await
        }.context("failed to query routines")?;

        let due: Vec<_> = all
            .iter()
            .filter(|r| {
                let freq: String = r.try_get("frequency").unwrap_or_default();
                let last: Option<chrono::NaiveDate> = r.try_get("last_task_date").unwrap_or(None);
                is_routine_due_mcp(&freq, last)
            })
            .collect();

        if due.is_empty() {
            return Ok(
                json!({"content": [{"type": "text", "text": "No routine tasks are due right now."}]}),
            );
        }

        if dry_run {
            let mut text = format!(
                "{} routine(s) due (dry run — no tasks created):\n\n",
                due.len()
            );
            for r in &due {
                let title: String = r.try_get("title").unwrap_or_default();
                let freq: String = r.try_get("frequency").unwrap_or_default();
                text.push_str(&format!("• {} ({})\n", title, freq));
            }
            return Ok(json!({"content": [{"type": "text", "text": text}]}));
        }

        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut created = Vec::new();

        for r in &due {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let project_id: Uuid = r.try_get("project_id").unwrap_or(Uuid::nil());
            let title: String = r.try_get("title").unwrap_or_default();
            let description: Option<String> = r.try_get("description").unwrap_or(None);
            let priority: String = r
                .try_get("priority")
                .unwrap_or_else(|_| "medium".to_string());
            let assigned_to: Option<String> = r.try_get("assigned_to").unwrap_or(None);

            let task_title = format!("{} — {}", title, today);
            let task = sqlx::query(
                "INSERT INTO project_tasks \
                 (project_id, routine_id, title, description, status, priority, assigned_to, created_by) \
                 VALUES ($1, $2, $3, $4, 'todo', $5, $6, 'agent') RETURNING id"
            )
            .bind(project_id).bind(id).bind(&task_title).bind(&description)
            .bind(&priority).bind(&assigned_to)
            .fetch_one(&self.db).await;

            if let Ok(row) = task {
                let task_id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
                created.push(format!("• {} [id: {}]", task_title, task_id));
                let _ = sqlx::query(
                    "UPDATE project_routines SET last_task_date = CURRENT_DATE, updated_at = NOW() WHERE id = $1"
                ).bind(id).execute(&self.db).await;
            }
        }

        let mut text = format!("Created {} task(s) from routines:\n\n", created.len());
        for line in &created {
            text.push_str(line);
            text.push('\n');
        }
        text.push_str("\nThese tasks are in status 'todo'. Handle them, then mark as done.");
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn routine_list(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;

        let rows = sqlx::query(
            "SELECT id, title, frequency, priority, assigned_to, last_task_date, enabled \
             FROM project_routines WHERE project_id = $1 ORDER BY created_at ASC",
        )
        .bind(project_id)
        .fetch_all(&self.db)
        .await
        .context("failed to list routines")?;

        if rows.is_empty() {
            return Ok(
                json!({"content": [{"type": "text", "text": "No routines defined. Use routine_create to add one."}]}),
            );
        }

        let mut text = format!("Routines ({}):\n\n", rows.len());
        for r in &rows {
            let id: Uuid = r.try_get("id").unwrap_or(Uuid::nil());
            let title: String = r.try_get("title").unwrap_or_default();
            let freq: String = r.try_get("frequency").unwrap_or_default();
            let priority: String = r.try_get("priority").unwrap_or_default();
            let enabled: bool = r.try_get("enabled").unwrap_or(true);
            let last: Option<chrono::NaiveDate> = r.try_get("last_task_date").unwrap_or(None);
            text.push_str(&format!(
                "• {} [{}] {} — last run: {}{}\n  id: {}\n",
                title,
                freq,
                priority,
                last.map(|d| d.to_string())
                    .unwrap_or_else(|| "never".to_string()),
                if !enabled { " (disabled)" } else { "" },
                id
            ));
        }
        Ok(json!({"content": [{"type": "text", "text": text}]}))
    }

    pub(super) async fn routine_create(
        &mut self,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value> {
        let project_id: Uuid = args["project_id"]
            .as_str()
            .context("missing project_id")?
            .parse()
            .context("invalid project_id UUID")?;
        let title = args["title"].as_str().context("missing title")?.to_string();
        let description = args["description"].as_str().map(|s| s.to_string());
        let frequency = args["frequency"].as_str().unwrap_or("daily");
        let priority = args["priority"].as_str().unwrap_or("medium");
        let assigned_to = args["assigned_to"].as_str().map(|s| s.to_string());

        let row = sqlx::query(
            "INSERT INTO project_routines (project_id, title, description, frequency, priority, assigned_to) \
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id"
        )
        .bind(project_id).bind(&title).bind(&description)
        .bind(frequency).bind(priority).bind(&assigned_to)
        .fetch_one(&self.db).await.context("failed to create routine")?;

        let id: Uuid = row.try_get("id").unwrap_or(Uuid::nil());
        Ok(json!({"content": [{"type": "text", "text": format!(
            "Created {} routine '{}'. Run routine_check to generate today's task.\n  id: {}",
            frequency, title, id
        )}]}))
    }
}
