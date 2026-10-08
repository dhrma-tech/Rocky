drop index if exists action_rules_active;
drop table if exists action_rules;
drop index if exists actions_execute_after;
alter table actions_queue drop column approved_by_rule;
alter table actions_queue drop column execute_after;
