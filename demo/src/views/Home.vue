<!--
 * @Author: shuoshubao
 * @Date: 2026-09-20 18:55:31
 * @LastEditors: shuoshubao
 * @LastEditTime: 2026-09-20 19:51:58
 * @Description: 
-->
<template>
  <div class="home">
    <h1>{{ title }}</h1>
    <el-button type="primary" @click="$store.commit('increment')">
      count = {{ $store.state.count }}
    </el-button>
    <el-button @click="$store.commit('increment', 5)">+5</el-button>
    <el-button @click="$store.commit('addTag', 'tag-' + Date.now())">add tag</el-button>
    <el-button @click="$store.dispatch('incrementAsync', 2)">async +2</el-button>
    <p>doubleCount (vuex getter): {{ $store.getters.doubleCount }}</p>

    <div class="cards">
      <user-card
        v-for="u in users"
        :key="u.id"
        :name="u.name"
        :age="u.age"
        :active="u.id === activeId"
        @select="activeId = u.id"
      />
    </div>

    <h2>el-table 用户管理</h2>
    <div class="toolbar">
      <el-input
        v-model="search"
        placeholder="搜索姓名 / 邮箱"
        clearable
        prefix-icon="el-icon-search"
        style="width: 240px"
      />
      <el-button type="primary" icon="el-icon-plus" @click="openDialog">新增用户</el-button>
    </div>

    <el-table :data="pagedUsers" stripe border style="width: 100%">
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="name" label="姓名" width="120" />
      <el-table-column label="角色" width="110">
        <template slot-scope="scope">
          <el-tag :type="roleMeta[scope.row.role].type">
            {{ roleMeta[scope.row.role].label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="email" label="邮箱" min-width="180" />
      <el-table-column label="状态" width="90">
        <template slot-scope="scope">
          <el-switch v-model="scope.row.status" />
        </template>
      </el-table-column>
      <el-table-column prop="created" label="创建时间" width="120" />
      <el-table-column label="操作" width="130" fixed="right">
        <template slot-scope="scope">
          <el-button type="text" @click="editUser(scope.row)">编辑</el-button>
          <el-button type="text" class="danger-link" @click="removeUser(scope.row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="filtered.length"
      :page-size="pageSize"
      :current-page.sync="currentPage"
    />

    <el-dialog
      :visible.sync="dialogVisible"
      :title="form.id ? '编辑用户' : '新增用户'"
      width="460px"
    >
      <el-form ref="formRef" :model="form" :rules="rules" label-width="70px">
        <el-form-item label="姓名" prop="name">
          <el-input v-model="form.name" placeholder="请输入姓名" />
        </el-form-item>
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="请输入邮箱" />
        </el-form-item>
        <el-form-item label="角色">
          <el-select v-model="form.role" style="width: 100%">
            <el-option label="管理员" value="admin" />
            <el-option label="编辑" value="editor" />
            <el-option label="访客" value="viewer" />
          </el-select>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.status" active-text="启用" inactive-text="停用" />
        </el-form-item>
      </el-form>
      <template slot="footer">
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitForm">确定</el-button>
      </template>
    </el-dialog>

    <h2>el-tree</h2>
    <el-tree
      :data="treeData"
      :props="treeProps"
      default-expand-all
      node-key="id"
      style="width: 480px"
    />
  </div>
</template>

<script>
import UserCard from '../components/UserCard.vue';

export default {
  name: 'Home',
  components: { UserCard },
  data() {
    return {
      title: 'Vue 2.6.14 Component Panel Demo',
      count: 0,
      activeId: 1,
      users: [
        { id: 1, name: 'Alice', age: 33 },
        { id: 2, name: 'Bob', age: 25 },
        { id: 3, name: 'Carol', age: 41 }
      ],
      treeProps: { label: 'label', children: 'children' },
      treeData: [
        {
          id: 1,
          label: 'Frontend',
          children: [
            { id: 4, label: 'Vue 2.6' },
            { id: 5, label: 'Element UI' }
          ]
        },
        {
          id: 2,
          label: 'Build',
          children: [
            { id: 6, label: 'Vite' },
            { id: 7, label: 'vite-plugin-vue2' }
          ]
        },
        { id: 3, label: 'Devtools' }
      ],
      roleMeta: {
        admin: { label: '管理员', type: 'danger' },
        editor: { label: '编辑', type: 'warning' },
        viewer: { label: '访客', type: 'info' }
      },
      search: '',
      currentPage: 1,
      pageSize: 5,
      dialogVisible: false,
      form: { id: null, name: '', role: 'viewer', email: '', status: true },
      rules: {
        name: [{ required: true, message: '请输入姓名', trigger: 'blur' }],
        email: [
          { required: true, message: '请输入邮箱', trigger: 'blur' },
          { type: 'email', message: '邮箱格式不正确', trigger: 'blur' }
        ]
      },
      tableUsers: [
        { id: 1, name: '张三', role: 'admin', email: 'zhangsan@example.com', status: true, created: '2026-01-12' },
        { id: 2, name: '李四', role: 'editor', email: 'lisi@example.com', status: true, created: '2026-02-03' },
        { id: 3, name: '王五', role: 'viewer', email: 'wangwu@example.com', status: false, created: '2026-03-21' },
        { id: 4, name: '赵六', role: 'editor', email: 'zhaoliu@example.com', status: true, created: '2026-04-18' },
        { id: 5, name: '孙七', role: 'viewer', email: 'sunqi@example.com', status: false, created: '2026-05-09' },
        { id: 6, name: '周八', role: 'admin', email: 'zhouba@example.com', status: true, created: '2026-06-30' },
        { id: 7, name: '吴九', role: 'editor', email: 'wujiu@example.com', status: true, created: '2026-07-14' }
      ]
    }
  },
  computed: {
    doubleCount() {
      return this.count * 2
    },
    filtered() {
      const kw = this.search.trim()
      return this.tableUsers.filter(
        (u) => u.name.includes(kw) || u.email.includes(kw)
      )
    },
    pagedUsers() {
      const start = (this.currentPage - 1) * this.pageSize
      return this.filtered.slice(start, start + this.pageSize)
    }
  },
  methods: {
    openDialog() {
      this.form = { id: null, name: '', role: 'viewer', email: '', status: true }
      this.dialogVisible = true
    },
    editUser(row) {
      this.form = { ...row }
      this.dialogVisible = true
    },
    submitForm() {
      this.$refs.formRef.validate((valid) => {
        if (!valid) return
        if (this.form.id) {
          const target = this.tableUsers.find((u) => u.id === this.form.id)
          Object.assign(target, this.form)
          this.$message.success('更新成功')
        } else {
          this.tableUsers.push({
            ...this.form,
            id: Date.now(),
            created: new Date().toISOString().slice(0, 10)
          })
          this.$message.success('新增成功')
        }
        this.dialogVisible = false
      })
    },
    removeUser(row) {
      this.$confirm(`确定删除用户「${row.name}」吗？`, '提示', {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消'
      })
        .then(() => {
          this.tableUsers = this.tableUsers.filter((u) => u.id !== row.id)
          this.$message.success('已删除')
        })
        .catch(() => {})
    }
  }
}
</script>

<style scoped>
.cards {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}
h2 {
  margin-top: 24px;
  font-size: 16px;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
}
.pager {
  margin-top: 16px;
  text-align: right;
}
.danger-link {
  color: #f56c6c;
}
</style>
